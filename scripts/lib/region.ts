import type { Locator, Page } from "playwright";

export type RegionStatus =
  | "uk-confirmed"
  | "uk-modal-dismissed"
  | "could-not-confirm";

export type RegionResult = {
  regionStatus: RegionStatus;
  detectedStore: string | null;
  detectedCurrency: string | null;
};

const OVERLAY_MARK_ATTR = "data-kl-region-overlay";
const CLOSE_MARK_ATTR = "data-kl-region-close";

// Text signals strong enough to mean "this element is a country/region/
// currency/store-switch prompt". Regex *sources* (strings, no literal
// RegExp objects) so the same list can be handed into browser-executed
// code below. Lowercase, used with the "i" flag. Includes Strathberry's
// known wording ("Shopping To ...") alongside generic equivalents so this
// stays reusable for other competitors.
const REGION_SIGNAL_SOURCES = [
  "shopping to",
  "currently browsing our united kingdom store",
  "shopping to united states",
  "you are (?:currently )?shopping (?:from|to)",
  "select (?:your )?(?:shipping )?country",
  "choose your (?:country|region|store)",
  "switch (?:store|country|region)",
  "ship(?:ping)? to",
];

// Requires an explicit statement that the customer IS on the UK store —
// not merely that "United Kingdom" appears somewhere (e.g. in a country
// picker list), which would be a false positive.
const UK_CONFIRMATION_SOURCES = [
  "(?:currently )?(?:browsing|shopping)(?: from| in)? our united kingdom store",
  "you'?re (?:currently )?on (?:the |our )?united kingdom (?:site|store)",
];

// A control that closes/dismisses the overlay while staying on the current
// store — never a "shop now" / "continue" / "yes" / country-name style
// action that would switch storefronts.
const CLOSE_OR_STAY_TEXT_PATTERN =
  /^close$|^dismiss$|^×$|^x$|^✕$|stay on|remain on|no,? stay|no thanks/i;

const CURRENCY_SIGNALS: { pattern: RegExp; code: string }[] = [
  { pattern: /\bGBP\b/, code: "GBP" },
  { pattern: /£/, code: "GBP" },
  { pattern: /\bEUR\b/, code: "EUR" },
  { pattern: /€/, code: "EUR" },
  // $ alone is ambiguous (USD/CAD/AUD/...); only an explicit "USD" code
  // counts as reliably observed.
  { pattern: /\bUSD\b/, code: "USD" },
];

function extractStore(text: string): string | null {
  const match = text.match(
    /(?:currently )?(?:browsing|shopping)(?: from| in)? our ([a-z][a-z\s]*?) store/i
  );
  return match ? match[1].trim() : null;
}

function extractCurrency(text: string): string | null {
  const codes = new Set(
    CURRENCY_SIGNALS.filter(({ pattern }) => pattern.test(text)).map(
      ({ code }) => code
    )
  );
  return codes.size === 1 ? [...codes][0] : null;
}

// ---------------------------------------------------------------------
// Browser-executed payloads.
//
// These MUST be built via `new Function(...)` from plain JS source
// strings rather than written as ordinary TypeScript functions. Playwright
// ships a function passed to page.evaluate() to the browser by calling
// Function.prototype.toString() on it and re-parsing that source there.
// When tsx/esbuild transpiles an ordinary named helper (e.g. a nested
// `const isVisible = (el) => {...}` inside an evaluate callback), it can
// rewrite it to `const isVisible = /* @__PURE__ */ __name((el) => {...},
// "isVisible")` to preserve Function.prototype.name — and that __name(...)
// call ends up baked into the stringified source. The browser has no such
// helper, so it throws `ReferenceError: __name is not defined`.
//
// Building these from raw strings via `new Function` sidesteps the
// transpiler entirely: esbuild never parses the *contents* of a string
// literal as code, so nothing it generates can leak into what gets shipped
// to the page.
// ---------------------------------------------------------------------

type BrowserFn<Arg, Result> = (arg: Arg) => Result;

const clearMarksFn = new Function(
  "attr",
  `
  var marked = document.querySelectorAll('[' + attr + ']');
  for (var i = 0; i < marked.length; i++) {
    marked[i].removeAttribute(attr);
  }
  `
) as unknown as BrowserFn<string, void>;

const getBodyInnerTextFn = new Function(
  "",
  `return document.body.innerText;`
) as unknown as BrowserFn<void, string>;

// Returns true if any strong region/store-switch text is currently visible
// anywhere on the page.
const isRegionSignalVisibleFn = new Function(
  "patternSources",
  `
  function isVisible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    var style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }
  var elements = document.querySelectorAll('body *');
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    if (!isVisible(el)) continue;
    var text = (el.innerText || '').trim();
    if (!text) continue;
    for (var j = 0; j < patternSources.length; j++) {
      if (new RegExp(patternSources[j], 'i').test(text)) return true;
    }
  }
  return false;
  `
) as unknown as BrowserFn<string[], boolean>;

type OverlayCandidateArgs = { patternSources: string[]; attr: string };
type OverlayCandidateResult = { text: string; matchedPatterns: string[] } | null;

// Searches all VISIBLE text on the page (not role/id/class) for a strong
// region/store-switch signal, then marks the smallest visible element
// whose text contains it — the tightest wrapper around the signal, i.e.
// the overlay/panel itself rather than <body> or a large ancestor.
const findOverlayCandidateFn = new Function(
  "args",
  `
  var patternSources = args.patternSources;
  var attr = args.attr;
  function isVisible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    var style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }
  var elements = document.querySelectorAll('body *');
  var matches = [];
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    if (!isVisible(el)) continue;
    var text = (el.innerText || '').trim();
    if (!text) continue;
    for (var j = 0; j < patternSources.length; j++) {
      if (new RegExp(patternSources[j], 'i').test(text)) {
        var rect = el.getBoundingClientRect();
        matches.push({ el: el, text: text, area: rect.width * rect.height, pattern: patternSources[j] });
        break;
      }
    }
  }
  if (matches.length === 0) return null;
  matches.sort(function (a, b) { return a.area - b.area; });
  // "Smallest sensible container" — prefer the smallest matched element
  // that also contains an interactive control (button/link), since a real
  // overlay panel wraps both its message text and its actions. A single
  // heading/paragraph line matches the text but has nothing clickable in
  // it, so it isn't a usable dismissal target on its own.
  var withControls = [];
  for (var m = 0; m < matches.length; m++) {
    if (matches[m].el.querySelectorAll('button, [role="button"], a').length > 0) {
      withControls.push(matches[m]);
    }
  }
  var chosen = withControls.length > 0 ? withControls[0] : matches[0];
  chosen.el.setAttribute(attr, 'true');
  var patternsSeen = [];
  for (var k = 0; k < matches.length; k++) {
    if (patternsSeen.indexOf(matches[k].pattern) === -1) patternsSeen.push(matches[k].pattern);
  }
  return { text: chosen.text, matchedPatterns: patternsSeen };
  `
) as unknown as BrowserFn<OverlayCandidateArgs, OverlayCandidateResult>;

export type CloseControlDiagnostic = {
  tag: string;
  accessibleName: string;
  ariaLabel: string | null;
  title: string | null;
  rect: { top: number; left: number; right: number; bottom: number; width: number; height: number };
  clickable: boolean;
  chosen: boolean;
};

type StructuralCloseArgs = {
  overlayAttr: string;
  closeAttr: string;
  ctaExcludeFragments: string[];
};
type StructuralCloseResult = { found: boolean; candidates: CloseControlDiagnostic[] };

// Text fragments that must never be picked as a "close" control, even if
// they'd otherwise pass the structural checks below — belt-and-braces on
// top of the accessible-name matching in findCloseControl().
const CTA_EXCLUDE_TEXT_FRAGMENTS = [
  "shop now",
  "continue",
  "united states",
  "yes",
];

// Structural fallback for a close control confined to the already-confirmed
// overlay element. Scans every descendant (not just <button>/<a>/[role])
// because a real "X" is often an SVG icon inside a plain <div>/<span>
// wrapper with a click handler and no button semantics at all. It never
// looks outside the overlay and never picks a control whose accessible
// name is a CTA like "SHOP NOW" or a country name. Also returns a capped
// list of every clickable candidate it considered, for diagnostics.
const findStructuralCloseControlFn = new Function(
  "args",
  `
  var overlayAttr = args.overlayAttr;
  var closeAttr = args.closeAttr;
  var ctaExcludeFragments = args.ctaExcludeFragments;
  var container = document.querySelector('[' + overlayAttr + '="true"]');
  if (!container) return { found: false, candidates: [] };

  var containerRect = container.getBoundingClientRect();
  var marginX = Math.max(24, containerRect.width * 0.25);
  var marginY = Math.max(24, containerRect.height * 0.25);

  function isExcludedCta(name) {
    var lower = name.toLowerCase();
    for (var i = 0; i < ctaExcludeFragments.length; i++) {
      if (lower.indexOf(ctaExcludeFragments[i]) !== -1) return true;
    }
    return false;
  }

  var all = container.querySelectorAll('*');
  var candidates = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    var role = el.getAttribute('role');
    var ariaLabel = el.getAttribute('aria-label');
    var titleAttr = el.getAttribute('title');
    var hasOnClick = el.hasAttribute('onclick');
    var hasTabIndex = el.hasAttribute('tabindex');
    var style = window.getComputedStyle(el);
    var cursorPointer = style.cursor === 'pointer';

    var clickable =
      tag === 'button' ||
      tag === 'a' ||
      tag === 'svg' ||
      role === 'button' ||
      role === 'link' ||
      hasOnClick ||
      hasTabIndex ||
      cursorPointer;

    if (!clickable) continue;

    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    var accessibleName = (ariaLabel || titleAttr || el.innerText || '').trim();

    candidates.push({
      tag: tag,
      accessibleName: accessibleName,
      ariaLabel: ariaLabel,
      title: titleAttr,
      rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      el: el,
      excluded: isExcludedCta(accessibleName)
    });
  }

  var best = null;

  // 1) Strongest signal: accessible name (aria-label/title/text) literally
  //    says close/dismiss, regardless of size or position.
  for (var a = 0; a < candidates.length; a++) {
    var c = candidates[a];
    if (c.excluded) continue;
    var lowerName = c.accessibleName.toLowerCase();
    if (lowerName.indexOf('close') !== -1 || lowerName.indexOf('dismiss') !== -1) {
      best = c;
      break;
    }
  }

  // 2) Fallback: icon-only (no/near-no accessible name), small, positioned
  //    in the top-right corner of the overlay — the classic "X" pattern.
  if (!best) {
    var topRightIconCandidates = [];
    for (var b = 0; b < candidates.length; b++) {
      var cand = candidates[b];
      if (cand.excluded) continue;
      if (cand.accessibleName.length > 3) continue;
      if (cand.rect.width > 60 || cand.rect.height > 60) continue;
      var isTopRight = cand.rect.right >= containerRect.right - marginX && cand.rect.top <= containerRect.top + marginY;
      if (!isTopRight) continue;
      topRightIconCandidates.push(cand);
    }
    topRightIconCandidates.sort(function (x, y) {
      return (x.rect.width * x.rect.height) - (y.rect.width * y.rect.height);
    });
    if (topRightIconCandidates.length > 0) {
      best = topRightIconCandidates[0];
    }
  }

  var found = false;
  if (best) {
    best.el.setAttribute(closeAttr, 'true');
    found = true;
  }

  // Cap the diagnostics list so logging stays readable on a busy overlay.
  var diagnosticSource = candidates.slice(0, 25);
  var resultCandidates = [];
  for (var d = 0; d < diagnosticSource.length; d++) {
    var dc = diagnosticSource[d];
    resultCandidates.push({
      tag: dc.tag,
      accessibleName: dc.accessibleName,
      ariaLabel: dc.ariaLabel,
      title: dc.title,
      rect: dc.rect,
      clickable: true,
      chosen: best === dc
    });
  }

  return { found: found, candidates: resultCandidates };
  `
) as unknown as BrowserFn<StructuralCloseArgs, StructuralCloseResult>;

// Exposed only so the regression test can exercise exactly what gets
// shipped to the browser (see scripts/lib/region.browser-eval.test.ts).
export const __browserEvalPayloads = {
  clearMarksFn,
  getBodyInnerTextFn,
  isRegionSignalVisibleFn,
  findOverlayCandidateFn,
  findStructuralCloseControlFn,
};

async function isRegionSignalVisible(page: Page): Promise<boolean> {
  return page.evaluate(isRegionSignalVisibleFn, REGION_SIGNAL_SOURCES);
}

async function findRegionOverlayCandidate(
  page: Page
): Promise<{ locator: Locator; text: string; matchedPatterns: string[] } | null> {
  await page.evaluate(clearMarksFn, OVERLAY_MARK_ATTR);

  const result = await page.evaluate(findOverlayCandidateFn, {
    patternSources: REGION_SIGNAL_SOURCES,
    attr: OVERLAY_MARK_ATTR,
  });

  if (!result) return null;
  return {
    locator: page.locator(`[${OVERLAY_MARK_ATTR}="true"]`).first(),
    text: result.text,
    matchedPatterns: result.matchedPatterns,
  };
}

function logCloseControlDiagnostics(candidates: CloseControlDiagnostic[]): void {
  if (candidates.length === 0) {
    console.log("Close control candidates: none found within overlay");
    return;
  }
  for (const c of candidates) {
    console.log(
      `Close control candidate: tag=${c.tag} accessibleName=${JSON.stringify(
        c.accessibleName
      )} ariaLabel=${JSON.stringify(c.ariaLabel)} title=${JSON.stringify(
        c.title
      )} rect=${JSON.stringify(c.rect)} clickable=${c.clickable} chosen=${c.chosen}`
    );
  }
}

/**
 * Scans every clickable-looking descendant of the confirmed overlay
 * (buttons, links, role="button", elements with an onclick/tabindex/
 * pointer-cursor, or a bare <svg> icon) and picks the best close control —
 * always logging what it considered so a live failure is debuggable from
 * the GitHub Actions log alone.
 */
async function findStructuralCloseControl(
  page: Page
): Promise<{ control: Locator | null; candidates: CloseControlDiagnostic[] }> {
  await page.evaluate(clearMarksFn, CLOSE_MARK_ATTR);

  const { found, candidates } = await page.evaluate(findStructuralCloseControlFn, {
    overlayAttr: OVERLAY_MARK_ATTR,
    closeAttr: CLOSE_MARK_ATTR,
    ctaExcludeFragments: CTA_EXCLUDE_TEXT_FRAGMENTS,
  });

  return {
    control: found ? page.locator(`[${CLOSE_MARK_ATTR}="true"]`).first() : null,
    candidates,
  };
}

async function findCloseControl(
  page: Page,
  overlay: Locator
): Promise<{ control: Locator | null; strategy: string }> {
  // Always run the structural scan first (even though accessible strategies
  // are tried first below) so its diagnostics are logged on every run, not
  // only on failure — that's what makes a live GitHub Actions run
  // debuggable if this still doesn't find the right element.
  const { control: structuralControl, candidates } = await findStructuralCloseControl(page);
  logCloseControlDiagnostics(candidates);

  const accessibleStrategies: { name: string; locator: Locator }[] = [
    {
      name: "accessible-role",
      locator: overlay.getByRole("button", { name: CLOSE_OR_STAY_TEXT_PATTERN }).first(),
    },
    {
      name: "aria-label",
      locator: overlay
        .locator('[aria-label*="close" i], [aria-label*="dismiss" i]')
        .first(),
    },
    {
      name: "title-attribute",
      locator: overlay.locator('[title*="close" i], [title*="dismiss" i]').first(),
    },
    {
      name: "text-match",
      locator: overlay
        .locator('button, a[role="button"], [role="button"]')
        .filter({ hasText: CLOSE_OR_STAY_TEXT_PATTERN })
        .first(),
    },
  ];

  for (const { name, locator } of accessibleStrategies) {
    try {
      if (await locator.isVisible()) {
        return { control: locator, strategy: name };
      }
    } catch {
      continue;
    }
  }

  if (structuralControl) {
    return { control: structuralControl, strategy: "structural-top-right" };
  }

  return { control: null, strategy: "none-found" };
}

/**
 * Detects a country/region/currency ("shopping to X?") overlay by scanning
 * visible page TEXT (not role/id/class) and, only when there is positive
 * evidence the page is already on the UK store, safely dismisses it via a
 * close control confined to that overlay. Never clicks "shop now",
 * "continue", or a country name. Reusable across competitors — the
 * Strathberry-specific wording lives only in the signal/confirmation
 * pattern lists above.
 */
export async function confirmUkRegion(page: Page): Promise<RegionResult> {
  // Give the overlay a brief moment to render after consent handling.
  await page.waitForTimeout(1000);

  const overlay = await findRegionOverlayCandidate(page);
  console.log(
    `Region signals found: ${
      overlay && overlay.matchedPatterns.length
        ? overlay.matchedPatterns.join(", ")
        : "none"
    }`
  );

  let bodyText = "";
  try {
    bodyText = await page.evaluate(getBodyInnerTextFn);
  } catch {
    bodyText = "";
  }
  const combinedText = `${overlay?.text ?? ""}\n${bodyText}`;

  const detectedStore = extractStore(combinedText);
  const detectedCurrency = extractCurrency(combinedText);
  const ukConfirmed = UK_CONFIRMATION_SOURCES.some((src) =>
    new RegExp(src, "i").test(combinedText)
  );
  console.log(
    `UK storefront evidence found: ${ukConfirmed}${
      detectedStore ? ` (detectedStore="${detectedStore}")` : ""
    }`
  );
  console.log(`Region overlay candidate found: ${overlay ? "yes" : "no"}`);

  if (!overlay) {
    console.log("Close control strategy: n/a (no overlay candidate)");
    console.log("Dismissal verified: n/a (no overlay candidate)");
    // "uk-confirmed" requires positive, independent UK evidence — the
    // earlier bug was returning it merely because no overlay was found.
    return {
      regionStatus: ukConfirmed ? "uk-confirmed" : "could-not-confirm",
      detectedStore,
      detectedCurrency,
    };
  }

  if (!ukConfirmed) {
    console.log("Close control strategy: skipped (UK storefront not confirmed)");
    console.log("Dismissal verified: false");
    return { regionStatus: "could-not-confirm", detectedStore, detectedCurrency };
  }

  const { control: closeControl, strategy } = await findCloseControl(
    page,
    overlay.locator
  );
  console.log(`Close control strategy: ${strategy}`);

  if (!closeControl) {
    console.log("Dismissal verified: false");
    return { regionStatus: "could-not-confirm", detectedStore, detectedCurrency };
  }

  try {
    await closeControl.click({ timeout: 3000 });
  } catch {
    console.log("Dismissal verified: false");
    return { regionStatus: "could-not-confirm", detectedStore, detectedCurrency };
  }

  await page.waitForTimeout(800);
  const verified = !(await isRegionSignalVisible(page));
  console.log(`Dismissal verified: ${verified}`);

  return {
    regionStatus: verified ? "uk-modal-dismissed" : "could-not-confirm",
    detectedStore,
    detectedCurrency,
  };
}
