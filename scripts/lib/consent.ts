import type { Locator, Page } from "playwright";

export type ConsentStatus = "accepted" | "rejected" | "not-present" | "could-not-dismiss";

const OVERLAY_MARK_ATTR = "data-kl-consent-overlay";
const REJECT_MARK_ATTR = "data-kl-consent-reject";
const ACCEPT_MARK_ATTR = "data-kl-consent-accept";

// Strong, specific cookie/privacy consent phrases (regex *sources* — plain
// strings, no literal RegExp objects — so the same list can be handed into
// browser-executed code below). Deliberately multi-word/specific rather
// than bare "cookies" or "privacy": a footer link reading just "Privacy"
// must never be mistaken for a consent overlay.
const COOKIE_SIGNAL_SOURCES = [
  "cookie policy",
  "cookie preferences",
  "cookie settings",
  "manage cookies",
  "accept all cookies",
  "reject all cookies",
  "storing of cookies",
  "cookies on your device",
  "tracking technologies",
  "use of cookies",
  "we use cookies",
  "this (?:website|site) uses cookies",
  "necessary cookies",
  "non-essential cookies",
  "privacy policy",
];

// Fragments matched against a candidate control's accessible name
// (lowercased, substring match). Longest/most specific first only matters
// for readability — any match is treated as equally valid evidence.
const REJECT_TEXT_FRAGMENTS = [
  "reject all cookies",
  "reject all",
  "decline all",
  "necessary cookies only",
  "only necessary",
  "continue without accepting",
  "reject",
  "decline",
];

const ACCEPT_TEXT_FRAGMENTS = [
  "accept all cookies",
  "accept all",
  "allow all",
  "accept cookies",
  "allow cookies",
  "accept",
  "allow",
];

// ---------------------------------------------------------------------
// Browser-executed payloads.
//
// Built via `new Function(...)` from plain JS source strings, exactly as
// in scripts/lib/region.ts — NOT as ordinary TypeScript functions. tsx's
// esbuild transpiler can inject a `__name(...)` helper call into a nested
// named function defined inside a page.evaluate() callback, to preserve
// Function.prototype.name; Playwright ships a function to the browser by
// calling .toString() on it and re-running that source there, so the
// injected helper call ends up baked into what gets sent to the page —
// and the browser has no such helper, producing
// `ReferenceError: __name is not defined` (a real production failure we
// hit in region.ts). Building these from raw strings sidesteps the
// transpiler entirely: esbuild never parses the *contents* of a string
// literal as code.
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

type OverlayCandidateArgs = { patternSources: string[]; attr: string };
type OverlayCandidateResult = { text: string; matchedPatterns: string[] } | null;

// Searches all VISIBLE text on the page (not role/id/class) for a strong
// cookie-consent signal, then marks the smallest visible element whose
// text contains it — preferring one that also contains a clickable
// descendant, since a real consent panel wraps both its message and its
// buttons, not a bare heading/paragraph line.
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

// Returns true if the element marked with `attr` (by findOverlayCandidateFn)
// still exists and is visible. More precise than re-scanning the whole page
// for cookie-related text, because cookie/privacy footer links legitimately
// persist on the page forever — verification must check "is the specific
// overlay we found gone", not "does the word cookie ever appear again".
const isMarkedElementVisibleFn = new Function(
  "attr",
  `
  var el = document.querySelector('[' + attr + '="true"]');
  if (!el) return false;
  var rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  var style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  if (parseFloat(style.opacity) === 0) return false;
  return true;
  `
) as unknown as BrowserFn<string, boolean>;

export type ConsentControlDiagnostic = {
  tag: string;
  accessibleName: string;
  ariaLabel: string | null;
  title: string | null;
  rect: { top: number; left: number; right: number; bottom: number; width: number; height: number };
  matched: "reject" | "accept" | "none";
};

type FindControlsArgs = {
  overlayAttr: string;
  rejectAttr: string;
  acceptAttr: string;
  rejectFragments: string[];
  acceptFragments: string[];
};
type FindControlsResult = {
  rejectFound: boolean;
  acceptFound: boolean;
  candidates: ConsentControlDiagnostic[];
};

// Scans every clickable-looking descendant of the confirmed cookie overlay
// — not just <button>/<a>/[role="button"], since a control may be a plain
// wrapper (div/span) around an icon or styled text with no button
// semantics — and classifies each by whether its accessible name matches a
// reject or accept fragment. Marks (at most) one reject and one accept
// candidate; never looks outside the confirmed overlay.
const findControlsFn = new Function(
  "args",
  `
  var overlayAttr = args.overlayAttr;
  var rejectAttr = args.rejectAttr;
  var acceptAttr = args.acceptAttr;
  var rejectFragments = args.rejectFragments;
  var acceptFragments = args.acceptFragments;
  var container = document.querySelector('[' + overlayAttr + '="true"]');
  if (!container) return { rejectFound: false, acceptFound: false, candidates: [] };

  function matchesAny(lowerName, fragments) {
    for (var i = 0; i < fragments.length; i++) {
      if (lowerName.indexOf(fragments[i]) !== -1) return true;
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
      role === 'button' ||
      role === 'link' ||
      hasOnClick ||
      hasTabIndex ||
      cursorPointer;

    if (!clickable) continue;

    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    var accessibleName = (ariaLabel || titleAttr || el.innerText || '').trim();
    var lowerName = accessibleName.toLowerCase();

    var matched = 'none';
    if (matchesAny(lowerName, rejectFragments)) {
      matched = 'reject';
    } else if (matchesAny(lowerName, acceptFragments)) {
      matched = 'accept';
    }

    candidates.push({
      tag: tag,
      accessibleName: accessibleName,
      ariaLabel: ariaLabel,
      title: titleAttr,
      rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      area: rect.width * rect.height,
      el: el,
      matched: matched
    });
  }

  var rejectCandidates = candidates.filter(function (c) { return c.matched === 'reject'; });
  var acceptCandidates = candidates.filter(function (c) { return c.matched === 'accept'; });
  rejectCandidates.sort(function (a, b) { return a.area - b.area; });
  acceptCandidates.sort(function (a, b) { return a.area - b.area; });

  var rejectFound = false;
  var acceptFound = false;
  if (rejectCandidates.length > 0) {
    rejectCandidates[0].el.setAttribute(rejectAttr, 'true');
    rejectFound = true;
  }
  if (acceptCandidates.length > 0) {
    acceptCandidates[0].el.setAttribute(acceptAttr, 'true');
    acceptFound = true;
  }

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
      matched: dc.matched
    });
  }

  return { rejectFound: rejectFound, acceptFound: acceptFound, candidates: resultCandidates };
  `
) as unknown as BrowserFn<FindControlsArgs, FindControlsResult>;

// Exposed only so the regression test can exercise exactly what gets
// shipped to the browser (see scripts/lib/consent.browser-eval.test.ts).
export const __browserEvalPayloads = {
  clearMarksFn,
  findOverlayCandidateFn,
  isMarkedElementVisibleFn,
  findControlsFn,
};

/**
 * Polls `check()` until it returns a non-null value or `maxWaitMs` elapses.
 * Used to give an asynchronously-injected consent UI a bounded chance to
 * appear without a fixed arbitrary sleep on every capture. Pure and
 * independent of Playwright so it can be unit-tested directly.
 */
export async function pollUntil<T>(
  check: () => Promise<T | null>,
  opts: {
    maxWaitMs: number;
    pollIntervalMs: number;
    sleep: (ms: number) => Promise<void>;
    // Defaults to Date.now; overridable so tests can drive a deterministic
    // fake clock instead of depending on real wall-clock time.
    now?: () => number;
  }
): Promise<T | null> {
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.maxWaitMs;
  let result = await check();
  while (result === null && now() < deadline) {
    await opts.sleep(opts.pollIntervalMs);
    result = await check();
  }
  return result;
}

async function findCookieOverlayCandidate(
  page: Page
): Promise<{ locator: Locator; text: string; matchedPatterns: string[] } | null> {
  await page.evaluate(clearMarksFn, OVERLAY_MARK_ATTR);

  const result = await page.evaluate(findOverlayCandidateFn, {
    patternSources: COOKIE_SIGNAL_SOURCES,
    attr: OVERLAY_MARK_ATTR,
  });

  if (!result) return null;
  return {
    locator: page.locator(`[${OVERLAY_MARK_ATTR}="true"]`).first(),
    text: result.text,
    matchedPatterns: result.matchedPatterns,
  };
}

function summarizeCandidates(candidates: ConsentControlDiagnostic[]): string {
  if (candidates.length === 0) return "none";
  const entries = candidates.slice(0, 8).map((c) => {
    const name = c.accessibleName.length > 40 ? `${c.accessibleName.slice(0, 40)}…` : c.accessibleName;
    return `${c.tag}:"${name}"->${c.matched}`;
  });
  const suffix = candidates.length > 8 ? `, +${candidates.length - 8} more` : "";
  return `[${entries.join(", ")}${suffix}]`;
}

/**
 * Detects a cookie/privacy consent overlay by scanning visible page TEXT
 * (not role/id/class) for strong, specific consent wording, then — only
 * once positively identified — looks for a control within that same
 * overlay: a direct reject-all if one exists, otherwise an accept-all
 * (this project allows accepting cookies; reliability matters more than
 * preferring rejection). Never searches the page globally for a generic
 * "Accept" button. Verifies the overlay is actually gone after clicking
 * before reporting success.
 */
export async function dismissCookieConsent(page: Page): Promise<ConsentStatus> {
  const overlay = await pollUntil(() => findCookieOverlayCandidate(page), {
    maxWaitMs: 5000,
    pollIntervalMs: 300,
    sleep: (ms) => page.waitForTimeout(ms),
  });

  console.log(
    `Cookie consent signals found: ${
      overlay && overlay.matchedPatterns.length ? overlay.matchedPatterns.join(", ") : "none"
    }`
  );
  console.log(`Cookie consent container found: ${overlay ? "yes" : "no"}`);

  if (!overlay) {
    console.log("Cookie controls found: n/a");
    console.log("Cookie dismissal strategy: none");
    console.log("Cookie dismissal verified: n/a");
    console.log("Consent status: not-present");
    return "not-present";
  }

  const { rejectFound, acceptFound, candidates } = await page.evaluate(findControlsFn, {
    overlayAttr: OVERLAY_MARK_ATTR,
    rejectAttr: REJECT_MARK_ATTR,
    acceptAttr: ACCEPT_MARK_ATTR,
    rejectFragments: REJECT_TEXT_FRAGMENTS,
    acceptFragments: ACCEPT_TEXT_FRAGMENTS,
  });
  console.log(`Cookie controls found: ${summarizeCandidates(candidates)}`);

  let strategy: "direct-reject" | "accept-all" | "none";
  let control: Locator | null = null;
  let statusOnSuccess: ConsentStatus;

  if (rejectFound) {
    strategy = "direct-reject";
    control = page.locator(`[${REJECT_MARK_ATTR}="true"]`).first();
    statusOnSuccess = "rejected";
  } else if (acceptFound) {
    strategy = "accept-all";
    control = page.locator(`[${ACCEPT_MARK_ATTR}="true"]`).first();
    statusOnSuccess = "accepted";
  } else {
    strategy = "none";
    statusOnSuccess = "could-not-dismiss";
  }
  console.log(`Cookie dismissal strategy: ${strategy}`);

  if (!control) {
    console.log("Cookie dismissal verified: n/a");
    console.log("Consent status: could-not-dismiss");
    return "could-not-dismiss";
  }

  try {
    await control.click({ timeout: 3000 });
  } catch {
    console.log("Cookie dismissal verified: false");
    console.log("Consent status: could-not-dismiss");
    return "could-not-dismiss";
  }

  await page.waitForTimeout(800);
  const verified = !(await page.evaluate(isMarkedElementVisibleFn, OVERLAY_MARK_ATTR));
  console.log(`Cookie dismissal verified: ${verified}`);

  const finalStatus: ConsentStatus = verified ? statusOnSuccess : "could-not-dismiss";
  console.log(`Consent status: ${finalStatus}`);
  return finalStatus;
}
