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

type StructuralCloseArgs = { overlayAttr: string; closeAttr: string };

// Structural fallback for an icon-only close control (no accessible name)
// positioned near the top-right corner of the already-confirmed overlay.
// Only runs within that specific overlay element — never globally. Only
// picks controls with no meaningful accessible name, so a labelled action
// like "SHOP NOW" or "United States" can never match.
const findStructuralCloseControlFn = new Function(
  "args",
  `
  var overlayAttr = args.overlayAttr;
  var closeAttr = args.closeAttr;
  var container = document.querySelector('[' + overlayAttr + '="true"]');
  if (!container) return false;
  var containerRect = container.getBoundingClientRect();
  var marginX = Math.max(24, containerRect.width * 0.2);
  var marginY = Math.max(24, containerRect.height * 0.2);
  var candidates = container.querySelectorAll('button, [role="button"], a');
  for (var i = 0; i < candidates.length; i++) {
    var el = candidates[i];
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.width > 60 || rect.height > 60) continue;
    var isTopRight = rect.right >= containerRect.right - marginX && rect.top <= containerRect.top + marginY;
    if (!isTopRight) continue;
    var accessibleName = (el.getAttribute('aria-label') || el.innerText || '').trim();
    if (accessibleName.length > 3) continue;
    el.setAttribute(closeAttr, 'true');
    return true;
  }
  return false;
  `
) as unknown as BrowserFn<StructuralCloseArgs, boolean>;

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

async function findStructuralCloseControl(page: Page): Promise<Locator | null> {
  await page.evaluate(clearMarksFn, CLOSE_MARK_ATTR);

  const found = await page.evaluate(findStructuralCloseControlFn, {
    overlayAttr: OVERLAY_MARK_ATTR,
    closeAttr: CLOSE_MARK_ATTR,
  });

  if (!found) return null;
  return page.locator(`[${CLOSE_MARK_ATTR}="true"]`).first();
}

async function findCloseControl(
  page: Page,
  overlay: Locator
): Promise<{ control: Locator | null; strategy: string }> {
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

  const structural = await findStructuralCloseControl(page);
  if (structural) {
    return { control: structural, strategy: "structural-top-right" };
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
