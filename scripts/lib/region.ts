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
// Distinct from CLOSE_MARK_ATTR (used by the generic structural fallback):
// marks the ranked, ordered set of safe click-target candidates resolved
// for the Strathberry-specific bounded retry below.
const STRATHBERRY_CANDIDATE_MARK_ATTR = "data-kl-region-close-candidate";
// Marks the TRUE enclosing Headless UI dialog panel once resolved (see
// resolveStrathberryDialogPanelFn below) — distinct from OVERLAY_MARK_ATTR,
// which live evidence showed can land on a small nested control (e.g. the
// country-selector button) rather than the actual modal panel.
const STRATHBERRY_PANEL_MARK_ATTR = "data-kl-region-strathberry-panel";

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

type StrathberryPanelArgs = { seedAttr: string; panelMarkAttr: string };
type StrathberryPanelResult = {
  seedRect: { top: number; left: number; right: number; bottom: number; width: number; height: number } | null;
  panelFound: boolean;
  panelRect: { top: number; left: number; right: number; bottom: number; width: number; height: number } | null;
  panelTextSample: string;
  resolutionStrategy: "headlessui-dialog-panel-id" | "text-and-size-heuristic" | "none";
};

// Live evidence showed the generic findOverlayCandidateFn above can lock
// onto a small nested control (Strathberry's 294x41 "United States"
// country-selector button, whose own text happens to match a region
// signal pattern) instead of the true modal panel. This Strathberry-
// specific step runs AFTER that seed is found and resolves the actual
// enclosing Headless UI dialog panel, searched upward from the seed:
//
//   1. Primary: the nearest ancestor whose `id` starts with
//      "headlessui-dialog-panel-" — a prefix match, since the generated
//      suffix varies between runs and must never be hardcoded.
//   2. Fallback: the nearest ancestor whose own text contains both a
//      shipping/shopping-to phrase and the UK-store confirmation wording,
//      and whose rect is modal-sized (>=150x150) — for markup that lacks
//      the Headless UI id entirely.
//
// Marks the resolved panel (not the seed) so all subsequent close-control
// discovery below operates against the true panel boundary.
const resolveStrathberryDialogPanelFn = new Function(
  "args",
  `
  var seedAttr = args.seedAttr;
  var panelMarkAttr = args.panelMarkAttr;
  var seed = document.querySelector('[' + seedAttr + '="true"]');
  if (!seed) {
    return { seedRect: null, panelFound: false, panelRect: null, panelTextSample: '', resolutionStrategy: 'none' };
  }

  function vpRect(r) {
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  var seedRect = seed.getBoundingClientRect();

  function hasHeadlessUiPanelId(el) {
    var id = el.getAttribute ? el.getAttribute('id') : null;
    return !!id && id.indexOf('headlessui-dialog-panel-') === 0;
  }

  function looksLikeShippingPanel(el) {
    var text = (el.innerText || '').toLowerCase();
    var hasShipWording = text.indexOf('shipping to') !== -1 || text.indexOf('shopping to') !== -1;
    var hasUkConfirmation = text.indexOf('united kingdom store') !== -1;
    if (!hasShipWording || !hasUkConfirmation) return false;
    var rect = el.getBoundingClientRect();
    return rect.width >= 150 && rect.height >= 150;
  }

  var panel = null;
  var strategy = 'none';

  var idNode = seed;
  var idDepth = 0;
  while (idNode && idDepth < 12) {
    if (hasHeadlessUiPanelId(idNode)) {
      panel = idNode;
      strategy = 'headlessui-dialog-panel-id';
      break;
    }
    idNode = idNode.parentElement;
    idDepth++;
  }

  if (!panel) {
    var textNode = seed.parentElement;
    var textDepth = 0;
    while (textNode && textDepth < 12) {
      if (looksLikeShippingPanel(textNode)) {
        panel = textNode;
        strategy = 'text-and-size-heuristic';
        break;
      }
      textNode = textNode.parentElement;
      textDepth++;
    }
  }

  if (!panel) {
    return { seedRect: vpRect(seedRect), panelFound: false, panelRect: null, panelTextSample: '', resolutionStrategy: 'none' };
  }

  panel.setAttribute(panelMarkAttr, 'true');
  var panelRect = panel.getBoundingClientRect();
  var sample = (panel.innerText || '').slice(0, 200);

  return {
    seedRect: vpRect(seedRect),
    panelFound: true,
    panelRect: vpRect(panelRect),
    panelTextSample: sample,
    resolutionStrategy: strategy
  };
  `
) as unknown as BrowserFn<StrathberryPanelArgs, StrathberryPanelResult>;

// Text that must never be picked as a close control, even if it happens to
// be small and top-right positioned — belt-and-braces on top of the
// structural exclusions in findStrathberryCloseCandidatesFn below.
const STRATHBERRY_FALLBACK_EXCLUDE_FRAGMENTS = [
  "shop now",
  "united states",
  "continue",
  "yes",
  "country",
  "dropdown",
];

export type StrathberryVisualX = {
  tag: string;
  rect: { top: number; left: number; right: number; bottom: number; width: number; height: number };
} | null;

export type StrathberryCandidateDiagnostic = {
  tag: string;
  rect: { top: number; left: number; right: number; bottom: number; width: number; height: number };
  role: string | null;
  ariaLabel: string | null;
  title: string | null;
  hasTabIndex: boolean;
  cursor: string;
  pointerEvents: string;
  hasOnClick: boolean;
  text: string;
  hasSvgOrPath: boolean;
  relationship: string;
  // Whether this candidate is, or is inside, the original (wrong)
  // findOverlayCandidateFn seed element — Strathberry's country-selector
  // button in the confirmed live evidence. Reported for every candidate,
  // not just rejected ones, so the diagnostics log makes the exclusion
  // visible either way.
  insideCountrySelector: boolean;
  // Whether this candidate's own class, or a descendant svg's class,
  // contains "chevron" (e.g. Font Awesome's fa-chevron-down) — the known
  // bad icon confirmed live inside the country selector.
  hasChevronClass: boolean;
  rank: number;
  accepted: boolean;
  rejectReason: string | null;
  // Index into the ranked, accepted-only candidate list (matches the
  // sequential mark attribute value used to build a Locator for it), or -1
  // if this candidate was rejected.
  order: number;
};

type StrathberryResolveArgs = {
  overlayAttr: string;
  markAttr: string;
  excludeFragments: string[];
  // Attribute marking the original (possibly wrong) seed element — e.g.
  // OVERLAY_MARK_ATTR or STRATHBERRY_PANEL_MARK_ATTR's excluded sibling —
  // whose subtree must never be treated as, or contain, the close control.
  // Optional: when omitted/empty, no ancestor-based exclusion is applied.
  excludeAncestorAttr?: string;
};
type StrathberryResolveResult = {
  visualX: StrathberryVisualX;
  candidates: StrathberryCandidateDiagnostic[];
  candidateCount: number;
  found: boolean;
};

// Separates two responsibilities that the previous implementation
// conflated:
//
//   (A) VISUAL X DISCOVERY — find the small, top-right, non-CTA icon that
//       visually represents the close "X" inside the already-confirmed
//       region overlay. Never searches outside that overlay.
//
//   (B) CLICK-TARGET RESOLUTION — starting from that visual element, walk
//       its ancestor chain (stopping at the overlay boundary) and rank
//       every node by how likely it is to be the actual interactive
//       target: button > [role=button] > <a> > [onclick] > [tabindex] >
//       cursor:pointer > <svg> > a generic small icon-only wrapper >
//       <path> (last resort — the artwork node itself). The smallest
//       bounding box is only used as a tie-breaker WITHIN the same rank,
//       never as the primary rule — an inner <path> no longer automatically
//       wins just because it happens to be the smallest node.
//
// All ranked, accepted candidates are marked (in rank order) so the caller
// can build Playwright Locators for each and try them in order — see
// attemptBoundedCandidateDismissal(). Rejected candidates are still
// reported (capped) for diagnostics, with a reason.
const findStrathberryCloseCandidatesFn = new Function(
  "args",
  `
  var overlayAttr = args.overlayAttr;
  var markAttr = args.markAttr;
  var excludeFragments = args.excludeFragments;
  var excludeAncestorAttr = args.excludeAncestorAttr;
  var container = document.querySelector('[' + overlayAttr + '="true"]');
  if (!container) return { visualX: null, candidates: [], candidateCount: 0, found: false };

  var excludedSeed = excludeAncestorAttr ? document.querySelector('[' + excludeAncestorAttr + '="true"]') : null;

  function isInsideExcludedSeed(el) {
    if (!excludedSeed) return false;
    if (el === excludedSeed) return true;
    return typeof excludedSeed.contains === 'function' && excludedSeed.contains(el);
  }

  function ownClassHasChevron(el) {
    var ownClass = el.getAttribute ? (el.getAttribute('class') || '') : '';
    return ownClass.toLowerCase().indexOf('chevron') !== -1;
  }

  function hasChevronClass(el) {
    if (ownClassHasChevron(el)) return true;
    if (el.querySelectorAll) {
      var svgs = el.querySelectorAll('svg, path');
      for (var s = 0; s < svgs.length; s++) {
        if (ownClassHasChevron(svgs[s])) return true;
      }
    }
    // A <path> (or other node) nested inside a chevron-classed <svg> is
    // part of that same icon, even though the class lives on an ancestor,
    // not on the node itself or one of its own descendants.
    var ancestor = el.parentElement;
    var ancestorDepth = 0;
    while (ancestor && ancestor !== container && ancestorDepth < 10) {
      if (ownClassHasChevron(ancestor)) return true;
      ancestor = ancestor.parentElement;
      ancestorDepth++;
    }
    return false;
  }

  var containerRect = container.getBoundingClientRect();
  var marginX = Math.max(24, containerRect.width * 0.25);
  var marginY = Math.max(24, containerRect.height * 0.25);

  function isVisible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    var style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  function containsExcludedText(text) {
    var lower = text.toLowerCase();
    for (var i = 0; i < excludeFragments.length; i++) {
      if (lower.indexOf(excludeFragments[i]) !== -1) return true;
    }
    return false;
  }

  function relativeRect(rect) {
    return {
      top: rect.top - containerRect.top,
      left: rect.left - containerRect.left,
      right: rect.right - containerRect.left,
      bottom: rect.bottom - containerRect.top,
      width: rect.width,
      height: rect.height
    };
  }

  // --- (A) Visual X discovery — same top-right/small/no-CTA-text
  // heuristic as before, used only to locate the icon area, not to decide
  // the click target.
  var all = container.querySelectorAll('*');
  var topRightSmall = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!isVisible(el)) continue;
    var rect = el.getBoundingClientRect();
    if (rect.width > 60 || rect.height > 60) continue;
    var isTopRight = rect.right >= containerRect.right - marginX && rect.top <= containerRect.top + marginY;
    if (!isTopRight) continue;
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    var ariaLabel = el.getAttribute('aria-label');
    var titleAttr = el.getAttribute('title');
    var text = (el.innerText || '').trim();
    var accessibleText = (ariaLabel || titleAttr || text || '').trim();
    var hasSvgOrPath = tag === 'svg' || tag === 'path' || el.querySelectorAll('svg, path').length > 0;
    var excludedHere = accessibleText.length > 3 || containsExcludedText(accessibleText) || containsExcludedText(text);
    if (excludedHere) continue;
    if (isInsideExcludedSeed(el)) continue;
    if (hasChevronClass(el)) continue;
    topRightSmall.push({ el: el, tag: tag, rect: rect, hasSvgOrPath: hasSvgOrPath, area: rect.width * rect.height });
  }
  var withSvg = topRightSmall.filter(function (c) { return c.hasSvgOrPath; });
  var pool = withSvg.length > 0 ? withSvg : topRightSmall;
  pool.sort(function (a, b) { return a.area - b.area; });
  var visualX = pool.length > 0 ? pool[0] : null;

  if (!visualX) {
    return { visualX: null, candidates: [], candidateCount: 0, found: false };
  }

  // --- (B) Click-target resolution — walk from the visual X up to (but
  // not including) the confirmed overlay container, ranking each node.
  function rankOf(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'button') return 1;
    if (el.getAttribute('role') === 'button') return 2;
    if (tag === 'a') return 3;
    if (el.hasAttribute('onclick')) return 4;
    if (el.hasAttribute('tabindex')) return 5;
    if (window.getComputedStyle(el).cursor === 'pointer') return 6;
    if (tag === 'svg') return 7;
    if (tag === 'path') return 9;
    return 8;
  }

  var chain = [];
  var node = visualX.el;
  var depth = 0;
  while (node && node !== container) {
    chain.push({ el: node, depth: depth });
    node = node.parentElement;
    depth++;
  }

  var raw = [];
  for (var c = 0; c < chain.length; c++) {
    var entry = chain[c];
    var cEl = entry.el;
    var cRect = cEl.getBoundingClientRect();
    var cTag = cEl.tagName.toLowerCase();
    var cRole = cEl.getAttribute('role');
    var cAriaLabel = cEl.getAttribute('aria-label');
    var cTitle = cEl.getAttribute('title');
    var cHasTabIndex = cEl.hasAttribute('tabindex');
    var cHasOnClick = cEl.hasAttribute('onclick');
    var cStyle = window.getComputedStyle(cEl);
    var cCursor = cStyle.cursor;
    var cPointerEvents = cStyle.pointerEvents;
    var cText = (cEl.innerText || '').trim();
    var cAccessibleText = (cAriaLabel || cTitle || cText || '').trim();
    var cHasSvgOrPath = cTag === 'svg' || cTag === 'path' || cEl.querySelectorAll('svg, path').length > 0;
    var cInsideCountrySelector = isInsideExcludedSeed(cEl);
    var cHasChevronClass = hasChevronClass(cEl);

    var rejectReason = null;
    if (cRect.width === 0 || cRect.height === 0) {
      rejectReason = 'not visible / zero-size';
    } else if (cInsideCountrySelector) {
      rejectReason = 'inside country selector control';
    } else if (cHasChevronClass) {
      rejectReason = 'fa-chevron-down icon (country selector chevron)';
    } else if (cRect.width > 80 || cRect.height > 80) {
      rejectReason = 'too large to be the X control';
    } else if (cAccessibleText.length > 3 && !cHasSvgOrPath) {
      rejectReason = 'meaningful text, not an icon wrapper';
    } else if (containsExcludedText(cAccessibleText) || containsExcludedText(cText)) {
      rejectReason = 'contains excluded CTA/country wording';
    } else {
      var cIsTopRight = cRect.right >= containerRect.right - marginX && cRect.top <= containerRect.top + marginY;
      if (!cIsTopRight) rejectReason = 'not in the overlay top-right close area';
    }

    raw.push({
      el: cEl,
      tag: cTag,
      rect: relativeRect(cRect),
      role: cRole,
      ariaLabel: cAriaLabel,
      title: cTitle,
      hasTabIndex: cHasTabIndex,
      cursor: cCursor,
      pointerEvents: cPointerEvents,
      hasOnClick: cHasOnClick,
      text: cText,
      hasSvgOrPath: cHasSvgOrPath,
      relationship: entry.depth === 0 ? 'self' : ('ancestor depth ' + entry.depth),
      insideCountrySelector: cInsideCountrySelector,
      hasChevronClass: cHasChevronClass,
      rank: rankOf(cEl),
      accepted: !rejectReason,
      rejectReason: rejectReason,
      area: cRect.width * cRect.height
    });
  }

  var accepted = raw.filter(function (c) { return c.accepted; });
  accepted.sort(function (a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.area - b.area;
  });
  for (var m = 0; m < accepted.length; m++) {
    accepted[m].el.setAttribute(markAttr, String(m));
  }

  var diagnosticSource = raw.slice(0, 15);
  var candidatesOut = [];
  for (var d = 0; d < diagnosticSource.length; d++) {
    var dc = diagnosticSource[d];
    candidatesOut.push({
      tag: dc.tag,
      rect: dc.rect,
      role: dc.role,
      ariaLabel: dc.ariaLabel,
      title: dc.title,
      hasTabIndex: dc.hasTabIndex,
      cursor: dc.cursor,
      pointerEvents: dc.pointerEvents,
      hasOnClick: dc.hasOnClick,
      text: dc.text,
      hasSvgOrPath: dc.hasSvgOrPath,
      relationship: dc.relationship,
      insideCountrySelector: dc.insideCountrySelector,
      hasChevronClass: dc.hasChevronClass,
      rank: dc.rank,
      accepted: dc.accepted,
      rejectReason: dc.rejectReason,
      order: accepted.indexOf(dc)
    });
  }

  return {
    visualX: { tag: visualX.tag, rect: relativeRect(visualX.rect) },
    candidates: candidatesOut,
    candidateCount: accepted.length,
    found: accepted.length > 0
  };
  `
) as unknown as BrowserFn<StrathberryResolveArgs, StrathberryResolveResult>;

// Precise check on the specific confirmed overlay element (attached AND
// visible), not a full-page text rescan — used by the bounded Strathberry
// dismissal verification below because a click can succeed while other,
// unrelated region-signal text still lingers momentarily elsewhere on the
// page (e.g. mid-animation), which would otherwise read as a false
// "still visible".
const isMarkedOverlayVisibleFn = new Function(
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

// Bounded secondary click strategy, used only when a real Playwright click
// on the resolved target fails (e.g. intercepted). Dispatches a plain
// element.click() on the EXACT SAME marked element — never a different
// element, never page coordinates.
const dispatchClickOnMarkedFn = new Function(
  "args",
  `
  var attr = args.attr;
  var value = args.value;
  var el = document.querySelector('[' + attr + '="' + value + '"]');
  if (!el) return false;
  el.click();
  return true;
  `
) as unknown as BrowserFn<{ attr: string; value: string }, boolean>;

// Exposed only so the regression test can exercise exactly what gets
// shipped to the browser (see scripts/lib/region.browser-eval.test.ts).
export const __browserEvalPayloads = {
  clearMarksFn,
  getBodyInnerTextFn,
  isRegionSignalVisibleFn,
  findOverlayCandidateFn,
  findStructuralCloseControlFn,
  resolveStrathberryDialogPanelFn,
  findStrathberryCloseCandidatesFn,
  isMarkedOverlayVisibleFn,
  dispatchClickOnMarkedFn,
};

// Exported (unchanged logic) so the capture orchestrator can poll it for a
// delayed overlay before running the full confirmUkRegion() flow — see
// scripts/lib/region-wait.ts.
export async function isRegionSignalVisible(page: Page): Promise<boolean> {
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

function logStrathberryResolutionDiagnostics(resolution: StrathberryResolveResult): void {
  if (resolution.visualX) {
    console.log(
      `Strathberry visual X: tag=${resolution.visualX.tag} rect=${JSON.stringify(resolution.visualX.rect)}`
    );
  } else {
    console.log("Strathberry visual X: none found within TRUE panel");
  }
  console.log(`Strathberry close candidates inside TRUE panel: ${resolution.candidates.length}`);
  for (const c of resolution.candidates) {
    console.log(
      `Strathberry close candidate: tag=${c.tag} relationship=${c.relationship} rank=${c.rank} ` +
        `rect=${JSON.stringify(c.rect)} role=${JSON.stringify(c.role)} ariaLabel=${JSON.stringify(
          c.ariaLabel
        )} title=${JSON.stringify(c.title)} tabindex=${c.hasTabIndex} cursor=${c.cursor} ` +
        `pointerEvents=${c.pointerEvents} onclick=${c.hasOnClick} text=${JSON.stringify(
          c.text
        )} hasSvgOrPath=${c.hasSvgOrPath} insideCountrySelector=${c.insideCountrySelector} ` +
        `hasChevronClass=${c.hasChevronClass} accepted=${c.accepted}` +
        `${c.rejectReason ? ` rejectReason=${JSON.stringify(c.rejectReason)}` : ""} order=${c.order}`
    );
  }
}

// Precise "is the given marked element actually gone" check used only by
// the bounded Strathberry retry below: checks the specific marked element
// first (hidden or detached), falling back to the existing, unmodified
// isRegionSignalVisible() as a second signal — never relying on only one
// text node disappearing. Parameterized by attr so it can verify either
// the original overlay seed or (now) the TRUE resolved dialog panel.
async function isStrathberryPanelGone(page: Page, markAttr: string): Promise<boolean> {
  const elementStillVisible = await page.evaluate(isMarkedOverlayVisibleFn, markAttr);
  if (elementStillVisible) return false;
  return !(await isRegionSignalVisible(page));
}

export type BoundedCandidateDismissDeps = {
  candidateCount: number;
  // Real Playwright click on the resolved candidate at `index`. Must never
  // use force:true as a first attempt.
  click: (index: number) => Promise<{ success: boolean; error?: string }>;
  // Bounded secondary strategy, confined to the SAME candidate — never a
  // different element, never page coordinates.
  dispatchSecondaryClick: (index: number) => Promise<void>;
  isOverlayGone: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  maxAttempts?: number;
  verifyPollIntervalMs?: number;
  verifyPollAttempts?: number;
  reappearCheckDelayMs?: number;
  candidateDescription?: (index: number) => string;
};

/**
 * Pure, injectable bounded-retry algorithm (no Page dependency, so it's
 * directly unit-testable): tries each resolved click-target candidate, in
 * rank order, up to a small bound. After each attempt it polls — bounded,
 * ~2s by default — for the overlay to disappear, then re-checks shortly
 * after in case it reappears. Stops immediately on the first candidate
 * that produces a genuine, stable dismissal.
 */
export async function attemptBoundedCandidateDismissal(
  deps: BoundedCandidateDismissDeps
): Promise<boolean> {
  const maxAttempts = Math.min(deps.candidateCount, deps.maxAttempts ?? 4);
  const verifyPollIntervalMs = deps.verifyPollIntervalMs ?? 400;
  const verifyPollAttempts = deps.verifyPollAttempts ?? 4;
  const reappearCheckDelayMs = deps.reappearCheckDelayMs ?? 400;
  const log = deps.log ?? (() => {});

  for (let i = 0; i < maxAttempts; i++) {
    const description = deps.candidateDescription ? deps.candidateDescription(i) : `candidate${i}`;
    const clickOutcome = await deps.click(i);

    let secondaryDispatchAttempted = false;
    if (!clickOutcome.success) {
      secondaryDispatchAttempted = true;
      await deps.dispatchSecondaryClick(i);
    }

    let gone = await deps.isOverlayGone();
    for (let poll = 0; !gone && poll < verifyPollAttempts; poll++) {
      await deps.sleep(verifyPollIntervalMs);
      gone = await deps.isOverlayGone();
    }

    let reappeared = false;
    if (gone) {
      await deps.sleep(reappearCheckDelayMs);
      reappeared = !(await deps.isOverlayGone());
    }

    log(
      `Strathberry click attempt ${i + 1}: target=${description} playwrightClickAttempted=true ` +
        `clickResult=${clickOutcome.success ? "success" : "failed"}` +
        `${clickOutcome.error ? ` error=${JSON.stringify(clickOutcome.error)}` : ""} ` +
        `secondaryDispatchAttempted=${secondaryDispatchAttempted} modalDisappeared=${gone && !reappeared} ` +
        `modalReappeared=${reappeared}`
    );

    if (gone && !reappeared) {
      return true;
    }
  }

  return false;
}

/**
 * Last-resort fallback used ONLY when the generic close-control strategies
 * above return none-found, AND only when all of the following already
 * hold: a region overlay was positively identified, UK storefront evidence
 * was positively found, and the overlay's own matched signals include the
 * Strathberry "Shopping To ..." / "Shipping To ..." wording specifically
 * (not just some other generic region signal). It never searches outside
 * the confirmed overlay, never touches the country picker, and never
 * clicks SHOP NOW. Thin real-Page wrapper around
 * findStrathberryCloseCandidatesFn (discovery + resolution) and
 * attemptBoundedCandidateDismissal (bounded retry + verification).
 *
 * Live evidence showed the confirmed region-overlay seed (OVERLAY_MARK_ATTR)
 * can itself be a small nested control (Strathberry's country-selector
 * button) rather than the true modal panel, so this first resolves the
 * actual enclosing Headless UI dialog panel via
 * resolveStrathberryDialogPanelFn and only then searches within it —
 * explicitly excluding the original seed's subtree and any
 * fa-chevron-down icon from close-control consideration.
 */
async function attemptStrathberryDismissal(page: Page): Promise<boolean> {
  await page.evaluate(clearMarksFn, STRATHBERRY_PANEL_MARK_ATTR);

  const panelResolution = await page.evaluate(resolveStrathberryDialogPanelFn, {
    seedAttr: OVERLAY_MARK_ATTR,
    panelMarkAttr: STRATHBERRY_PANEL_MARK_ATTR,
  });
  console.log(`Strathberry region seed rect: ${JSON.stringify(panelResolution.seedRect)}`);
  console.log(`Strathberry resolved dialog panel: ${panelResolution.panelFound}`);
  console.log(`Strathberry dialog panel rect: ${JSON.stringify(panelResolution.panelRect)}`);
  console.log(`Strathberry dialog panel text signals: ${JSON.stringify(panelResolution.panelTextSample)}`);
  console.log(`Strathberry dialog panel resolution strategy: ${panelResolution.resolutionStrategy}`);

  if (!panelResolution.panelFound) {
    return false;
  }

  await page.evaluate(clearMarksFn, STRATHBERRY_CANDIDATE_MARK_ATTR);

  const resolution = await page.evaluate(findStrathberryCloseCandidatesFn, {
    overlayAttr: STRATHBERRY_PANEL_MARK_ATTR,
    markAttr: STRATHBERRY_CANDIDATE_MARK_ATTR,
    excludeFragments: STRATHBERRY_FALLBACK_EXCLUDE_FRAGMENTS,
    excludeAncestorAttr: OVERLAY_MARK_ATTR,
  });
  logStrathberryResolutionDiagnostics(resolution);

  if (!resolution.found || resolution.candidateCount === 0) {
    return false;
  }

  const acceptedByOrder = resolution.candidates
    .filter((c) => c.accepted && c.order >= 0)
    .sort((a, b) => a.order - b.order);

  const selected = acceptedByOrder[0];
  console.log(
    selected
      ? `Strathberry selected close target: tag=${selected.tag} relationship=${selected.relationship} ` +
          `rect=${JSON.stringify(selected.rect)} insideCountrySelector=${selected.insideCountrySelector} ` +
          `hasChevronClass=${selected.hasChevronClass}`
      : "Strathberry selected close target: none"
  );

  return attemptBoundedCandidateDismissal({
    candidateCount: resolution.candidateCount,
    candidateDescription: (index) => {
      const c = acceptedByOrder[index];
      return c ? `candidate${index}(tag=${c.tag}, relationship=${c.relationship})` : `candidate${index}`;
    },
    click: async (index) => {
      try {
        await page
          .locator(`[${STRATHBERRY_CANDIDATE_MARK_ATTR}="${index}"]`)
          .first()
          .click({ timeout: 1200 });
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message.split("\n")[0] : String(err),
        };
      }
    },
    dispatchSecondaryClick: async (index) => {
      try {
        await page.evaluate(dispatchClickOnMarkedFn, {
          attr: STRATHBERRY_CANDIDATE_MARK_ATTR,
          value: String(index),
        });
      } catch {
        // No further fallback — the bounded loop moves on to the next
        // candidate (or gives up) based on the verification check below.
      }
    },
    isOverlayGone: () => isStrathberryPanelGone(page, STRATHBERRY_PANEL_MARK_ATTR),
    sleep: (ms) => page.waitForTimeout(ms),
    log: (message) => console.log(message),
  });
}

// The gate deciding whether the Strathberry-specific fallback above may
// run at all: only when the confirmed overlay's own matched region
// signals include wording specific to Strathberry's "Shopping To ...?" /
// "Shipping To ...?" prompt (both observed live), not just any other
// generic region/store-switch signal. Exported (pure, no side effects) so
// this exact gate can be tested directly against known matchedPatterns
// inputs without needing a Page. Values compared are the exact regex
// *source* strings from REGION_SIGNAL_SOURCES (region.ts, unchanged) that
// findOverlayCandidateFn reports as matched.
export function strathberryFallbackAppliesTo(matchedPatterns: string[]): boolean {
  return matchedPatterns.some(
    (pattern) =>
      pattern === "shopping to" ||
      pattern === "shopping to united states" ||
      pattern === "ship(?:ping)? to"
  );
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

  // Last-resort fallback for Strathberry's own overlay specifically, only
  // once the generic strategies have already failed and only when this is
  // genuinely the "Shopping To ...?" / "Shipping To ...?" overlay (not some
  // other unrelated region signal) with UK storefront evidence already
  // confirmed above. See strathberryFallbackAppliesTo() for the gate, and
  // attemptStrathberryDismissal() for the bounded, multi-candidate
  // click-target resolution/execution/verification.
  if (!closeControl) {
    if (strathberryFallbackAppliesTo(overlay.matchedPatterns)) {
      console.log("Close control strategy: strathberry-true-panel-fallback");
      const dismissed = await attemptStrathberryDismissal(page);
      console.log(`Dismissal verified: ${dismissed}`);
      return {
        regionStatus: dismissed ? "uk-modal-dismissed" : "could-not-confirm",
        detectedStore,
        detectedCurrency,
      };
    }

    console.log(`Close control strategy: ${strategy}`);
    console.log("Dismissal verified: false");
    return { regionStatus: "could-not-confirm", detectedStore, detectedCurrency };
  }

  console.log(`Close control strategy: ${strategy}`);

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
