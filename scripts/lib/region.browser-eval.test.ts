/**
 * Regression test for the "ReferenceError: __name is not defined" crash.
 *
 * Playwright ships a function passed to page.evaluate() to the browser by
 * calling Function.prototype.toString() on it, sending that source across
 * the wire, and reconstructing + running it in the page's own JS context.
 * That context has none of tsx/esbuild's Node-side helpers.
 *
 * This test reproduces exactly that: it takes the real payload functions
 * from region.ts, stringifies them the same way Playwright does, and
 * re-executes them inside a Node vm context that deliberately does NOT
 * define `__name` (or anything else from the Node module scope) — plus a
 * minimal fake DOM — so a stray reference to a transpiler helper fails
 * here the same way it failed in the live GitHub Actions run.
 *
 * Run with: npx tsx scripts/lib/region.browser-eval.test.ts
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  __browserEvalPayloads,
  strathberryFallbackAppliesTo,
  attemptBoundedCandidateDismissal,
  type StrathberryCandidateDiagnostic,
} from "./region";

type FakeStyle = { visibility: string; display: string; opacity: string; cursor: string; pointerEvents: string };
type FakeRect = { top: number; left: number; right: number; bottom: number; width: number; height: number };

class FakeElement {
  tagName: string;
  private attrs: Record<string, string>;
  private text: string;
  private rect: FakeRect;
  style: FakeStyle;
  children: FakeElement[];
  parentElement: FakeElement | null = null;

  constructor(
    tagName: string,
    opts: {
      text?: string;
      attrs?: Record<string, string>;
      rect?: Partial<FakeRect>;
      style?: Partial<FakeStyle>;
      children?: FakeElement[];
    } = {}
  ) {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...(opts.attrs ?? {}) };
    this.text = opts.text ?? "";
    this.rect = {
      top: 0,
      left: 0,
      right: 100,
      bottom: 50,
      width: 100,
      height: 50,
      ...(opts.rect ?? {}),
    };
    this.style = {
      visibility: "visible",
      display: "block",
      opacity: "1",
      cursor: "auto",
      pointerEvents: "auto",
      ...(opts.style ?? {}),
    };
    this.children = opts.children ?? [];
  }

  get innerText(): string {
    if (this.text) return this.text;
    return this.children.map((c) => c.innerText).filter(Boolean).join("\n");
  }

  getBoundingClientRect() {
    return this.rect;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }

  removeAttribute(name: string) {
    delete this.attrs[name];
  }

  hasAttr(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }

  hasAttribute(name: string): boolean {
    return this.hasAttr(name);
  }

  hide() {
    // Real browsers cascade display:none to descendants' rendered boxes
    // (their getBoundingClientRect collapses to 0x0 too); this fake DOM has
    // no layout engine, so apply it to every descendant explicitly to get
    // the same effect for the isVisible() checks in the payloads under test.
    this.style.display = "none";
    for (const child of this.allDescendantsPublic()) {
      child.style.display = "none";
    }
  }

  private allDescendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) {
      out.push(child);
      out.push(...child.allDescendantsPublic());
    }
    return out;
  }

  allDescendantsPublic(): FakeElement[] {
    return this.allDescendants();
  }

  querySelectorAll(selector: string): FakeElement[] {
    const pool = this.allDescendants();

    if (selector === "body *" || selector === "*") return pool;

    const attrOnlyMatch = selector.match(/^\[([a-zA-Z0-9_-]+)\]$/);
    if (attrOnlyMatch) {
      return pool.filter((el) => el.hasAttr(attrOnlyMatch[1]));
    }

    const attrValueMatch = selector.match(/^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/);
    if (attrValueMatch) {
      return pool.filter((el) => el.getAttribute(attrValueMatch[1]) === attrValueMatch[2]);
    }

    if (selector === 'button, [role="button"], a') {
      return pool.filter(
        (el) => el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button"
      );
    }

    if (selector === "svg, path") {
      return pool.filter((el) => el.tagName === "SVG" || el.tagName === "PATH");
    }

    throw new Error(`FakeElement.querySelectorAll: unsupported selector "${selector}"`);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function makeFakeDocument(body: FakeElement) {
  return {
    body,
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    querySelector: (selector: string) => body.querySelector(selector),
  };
}

// Wires up .parentElement across the whole tree (needed for the ancestor
// walk in findStrathberryCloseCandidatesFn) — FakeElement's constructor
// builds children bottom-up, so this is done as a separate pass.
function linkParents(root: FakeElement): void {
  for (const child of root.children) {
    child.parentElement = root;
    linkParents(child);
  }
}

/**
 * Reconstructs a `new Function(...)`-built payload exactly the way
 * Playwright reconstructs a function it ships to the browser: stringify,
 * then re-parse and run in a fresh context.
 */
function reconstructInBrowserLikeSandbox<Arg, Result>(
  fn: (arg: Arg) => Result,
  document: ReturnType<typeof makeFakeDocument>
): (arg: Arg) => Result {
  const source = fn.toString();
  const sandbox: Record<string, unknown> = {
    document,
    window: {
      getComputedStyle: (el: FakeElement) => el.style,
    },
    console,
  };
  vm.createContext(sandbox);
  // Deliberately no `__name`, no other Node/tsx/esbuild globals — this is
  // what actually reproduces the reported crash if it's still present.
  const script = new vm.Script(`(${source})`, { filename: "browser-eval-sandbox.js" });
  return script.runInContext(sandbox) as (arg: Arg) => Result;
}

function buildStrathberryOverlayFixture() {
  const closeButton = new FakeElement("button", {
    text: "",
    attrs: {},
    rect: { top: 4, left: 260, right: 296, bottom: 40, width: 36, height: 36 },
  });
  const shopNowButton = new FakeElement("button", {
    text: "SHOP NOW",
    rect: { top: 200, left: 20, right: 280, bottom: 240, width: 260, height: 40 },
  });
  const overlayPanel = new FakeElement("div", {
    rect: { top: 0, left: 0, right: 300, bottom: 260, width: 300, height: 260 },
    children: [
      new FakeElement("h2", { text: "Shopping To United States?" }),
      new FakeElement("p", {
        text: "You are currently browsing our United Kingdom store.",
      }),
      new FakeElement("span", { text: "SHOPPING TO" }),
      new FakeElement("span", { text: "United States" }),
      shopNowButton,
      closeButton,
    ],
  });
  const header = new FakeElement("header", { text: "Strathberry" });
  const body = new FakeElement("body", { children: [header, overlayPanel] });
  return { body, overlayPanel, closeButton, shopNowButton };
}

/**
 * Reproduces the exact live DOM shape reported after the generic close
 * strategies (accessible-role/aria-label/text-match/structural-top-right)
 * all returned none-found on the real Strathberry "Shopping To ...?"
 * overlay: the visible close "X" is an SVG icon inside a plain <div>
 * wrapper with NO button tag, NO role, NO aria-label/title, NO tabindex,
 * NO onclick, and NO cursor:pointer — none of which the generic
 * strategies require it to have, but all of which it lacks anyway.
 * Also includes decoys (SHOP NOW, a United States country row, a small
 * "Yes" chip, and an unrelated close X entirely outside the modal) to
 * prove the fallback never picks any of them.
 */
const OVERLAY_ATTR = "data-kl-region-overlay";
const STRATHBERRY_CANDIDATE_ATTR = "data-kl-region-close-candidate";
const STRATHBERRY_EXCLUDE_FRAGMENTS = ["shop now", "united states", "continue", "yes", "country", "dropdown"];

/**
 * Builds a confirmed Strathberry-style region modal (heading + UK
 * confirmation text + optional SHOP NOW / country row / decoy "Yes" chip),
 * with a given close-target subtree inserted, and optionally an unrelated
 * close "X" living outside the modal (e.g. a site header close button) to
 * prove the resolution never leaves the confirmed overlay boundary.
 */
function buildStrathberryModal(opts: {
  closeTarget?: FakeElement;
  includeShopNow?: boolean;
  includeCountryRow?: boolean;
  includeDecoyYes?: boolean;
  includeHeaderX?: boolean;
}) {
  const shopNowButton =
    opts.includeShopNow !== false
      ? new FakeElement("button", {
          text: "SHOP NOW",
          rect: { top: 200, left: 20, right: 280, bottom: 240, width: 260, height: 40 },
        })
      : null;
  const countryRow =
    opts.includeCountryRow !== false
      ? new FakeElement("div", {
          text: "United States",
          rect: { top: 120, left: 20, right: 280, bottom: 160, width: 260, height: 40 },
        })
      : null;
  const decoyYesChip = opts.includeDecoyYes
    ? new FakeElement("span", {
        text: "Yes",
        rect: { top: 6, left: 230, right: 256, bottom: 30, width: 26, height: 24 },
      })
    : null;

  const children: FakeElement[] = [
    new FakeElement("h2", { text: "Shopping To United States?" }),
    new FakeElement("p", { text: "You are currently browsing our United Kingdom store." }),
  ];
  if (countryRow) children.push(countryRow);
  if (shopNowButton) children.push(shopNowButton);
  if (decoyYesChip) children.push(decoyYesChip);
  if (opts.closeTarget) children.push(opts.closeTarget);

  const overlayPanel = new FakeElement("div", {
    rect: { top: 0, left: 0, right: 300, bottom: 260, width: 300, height: 260 },
    children,
  });

  const bodyChildren = [new FakeElement("header", { text: "Strathberry" }), overlayPanel];
  let headerX: FakeElement | null = null;
  if (opts.includeHeaderX) {
    // A separate close "X" living in the site header, well outside the
    // modal — must never be selected.
    headerX = new FakeElement("button", {
      attrs: { "aria-label": "Close" },
      rect: { top: 4, left: 760, right: 796, bottom: 40, width: 36, height: 36 },
    });
    bodyChildren.push(headerX);
  }

  const body = new FakeElement("body", { children: bodyChildren });
  linkParents(body);
  overlayPanel.setAttribute(OVERLAY_ATTR, "true");

  return { body, overlayPanel, shopNowButton, countryRow, decoyYesChip, headerX };
}

function resolveStrathberryCandidates(body: FakeElement) {
  const document = makeFakeDocument(body);
  const findCandidates = reconstructInBrowserLikeSandbox(
    __browserEvalPayloads.findStrathberryCloseCandidatesFn,
    document
  );
  return findCandidates({
    overlayAttr: OVERLAY_ATTR,
    markAttr: STRATHBERRY_CANDIDATE_ATTR,
    excludeFragments: STRATHBERRY_EXCLUDE_FRAGMENTS,
  });
}

function acceptedOrderZero(
  candidates: StrathberryCandidateDiagnostic[]
): StrathberryCandidateDiagnostic | undefined {
  return candidates.find((c) => c.order === 0);
}

async function run() {
  console.log("Running region.ts browser-evaluation regression tests...");

  // 1. isRegionSignalVisibleFn: detects the overlay text, and correctly
  //    reports false once it's gone (element removed / text absent).
  {
    const { body } = buildStrathberryOverlayFixture();
    const document = makeFakeDocument(body);
    const isRegionSignalVisible = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.isRegionSignalVisibleFn,
      document
    );
    const patternSources = [
      "shopping to",
      "currently browsing our united kingdom store",
      "shopping to united states",
    ];
    assert.equal(isRegionSignalVisible(patternSources), true);

    const emptyBody = new FakeElement("body", { children: [new FakeElement("header", { text: "Strathberry" })] });
    const isRegionSignalVisibleEmpty = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.isRegionSignalVisibleFn,
      makeFakeDocument(emptyBody)
    );
    assert.equal(isRegionSignalVisibleEmpty(patternSources), false);
    console.log("  ok: isRegionSignalVisibleFn (present + absent cases)");
  }

  // 2. findOverlayCandidateFn: finds and marks the smallest visible element
  //    containing the region-signal text (the panel, not <body>).
  {
    const { body, overlayPanel } = buildStrathberryOverlayFixture();
    const document = makeFakeDocument(body);
    const findOverlayCandidate = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.findOverlayCandidateFn,
      document
    );
    const result = findOverlayCandidate({
      patternSources: [
        "shopping to",
        "currently browsing our united kingdom store",
        "shopping to united states",
      ],
      attr: "data-kl-region-overlay",
    });
    assert.ok(result, "expected an overlay candidate to be found");
    assert.match(result!.text, /Shopping To United States/);
    assert.ok(result!.matchedPatterns.includes("shopping to"));
    assert.equal(
      overlayPanel.getAttribute("data-kl-region-overlay"),
      "true",
      "the overlay panel element itself should be marked"
    );
    console.log("  ok: findOverlayCandidateFn (marks the overlay panel)");
  }

  // 3. findStructuralCloseControlFn: picks the icon-only top-right control,
  //    never the labelled "SHOP NOW" button.
  {
    const { body, overlayPanel, closeButton, shopNowButton } = buildStrathberryOverlayFixture();
    overlayPanel.setAttribute("data-kl-region-overlay", "true");
    const document = makeFakeDocument(body);
    const findStructuralCloseControl = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.findStructuralCloseControlFn,
      document
    );
    const found = findStructuralCloseControl({
      overlayAttr: "data-kl-region-overlay",
      closeAttr: "data-kl-region-close",
    });
    assert.equal(found, true);
    assert.equal(closeButton.getAttribute("data-kl-region-close"), "true");
    assert.equal(
      shopNowButton.getAttribute("data-kl-region-close"),
      null,
      "SHOP NOW must never be marked as the close control"
    );
    console.log("  ok: findStructuralCloseControlFn (picks the icon-only control, not SHOP NOW)");
  }

  // 3b. findStrathberryCloseCandidatesFn: click-target resolution across
  //     multiple plausible live DOM shapes. Root cause of the previous live
  //     failure: the old implementation always picked the smallest visible
  //     SVG/path node — here that would mean picking the tiny <path>, which
  //     is what happened live (chosen=true on a ~10x6px path) and did not
  //     reliably dismiss the modal. These fixtures prove rank (not size) is
  //     the primary rule, with size only breaking ties within the same rank.

  // Fixture 1: DIV wrapper (cursor:pointer) > SVG > PATH, PATH smaller than
  // SVG. Expected: the wrapper is picked (cursor:pointer outranks a bare
  // SVG or its path), not the path.
  {
    const path = new FakeElement("path", {
      rect: { top: 18, left: 283, right: 293, bottom: 24, width: 10, height: 6 },
    });
    const svg = new FakeElement("svg", {
      rect: { top: 14, left: 280, right: 296, bottom: 30, width: 16, height: 16 },
      children: [path],
    });
    const wrapper = new FakeElement("div", {
      style: { cursor: "pointer" },
      rect: { top: 4, left: 260, right: 296, bottom: 40, width: 36, height: 36 },
      children: [svg],
    });
    const { body, shopNowButton, countryRow } = buildStrathberryModal({ closeTarget: wrapper });
    const result = resolveStrathberryCandidates(body);
    const top = acceptedOrderZero(result.candidates);
    assert.equal(result.found, true, "Fixture 1: expected a candidate to be found");
    assert.equal(wrapper.getAttribute(STRATHBERRY_CANDIDATE_ATTR), "0", "Fixture 1: wrapper must be the top pick");
    assert.notEqual(path.getAttribute(STRATHBERRY_CANDIDATE_ATTR), "0", "Fixture 1: PATH must never be the top-ranked pick");
    assert.equal(top?.tag, "div");
    assert.equal(shopNowButton?.getAttribute(STRATHBERRY_CANDIDATE_ATTR), null);
    assert.equal(countryRow?.getAttribute(STRATHBERRY_CANDIDATE_ATTR), null);
    console.log("  ok: Fixture 1 (cursor:pointer wrapper beats its smaller SVG/PATH descendants)");
  }

  // Fixture 2: BUTTON > SVG > PATH. Expected: the button is picked.
  {
    const path = new FakeElement("path", {
      rect: { top: 18, left: 283, right: 293, bottom: 24, width: 10, height: 6 },
    });
    const svg = new FakeElement("svg", {
      rect: { top: 14, left: 280, right: 296, bottom: 30, width: 16, height: 16 },
      children: [path],
    });
    const button = new FakeElement("button", {
      rect: { top: 4, left: 260, right: 296, bottom: 40, width: 36, height: 36 },
      children: [svg],
    });
    const { body } = buildStrathberryModal({ closeTarget: button });
    const result = resolveStrathberryCandidates(body);
    assert.equal(button.getAttribute(STRATHBERRY_CANDIDATE_ATTR), "0", "Fixture 2: the <button> must be picked");
    assert.notEqual(path.getAttribute(STRATHBERRY_CANDIDATE_ATTR), "0");
    assert.equal(result.found, true);
    console.log("  ok: Fixture 2 (explicit <button> always wins)");
  }

  // Fixture 3: a bare interactive SVG > PATH, no wrapper at all. Expected:
  // the SVG is picked, not its PATH.
  {
    const path = new FakeElement("path", {
      rect: { top: 18, left: 283, right: 293, bottom: 24, width: 10, height: 6 },
    });
    const svg = new FakeElement("svg", {
      rect: { top: 4, left: 260, right: 296, bottom: 40, width: 36, height: 36 },
      children: [path],
    });
    const { body } = buildStrathberryModal({ closeTarget: svg });
    const result = resolveStrathberryCandidates(body);
    assert.equal(svg.getAttribute(STRATHBERRY_CANDIDATE_ATTR), "0", "Fixture 3: the <svg> must be picked over its <path>");
    assert.notEqual(path.getAttribute(STRATHBERRY_CANDIDATE_ATTR), "0");
    assert.equal(result.found, true);
    console.log("  ok: Fixture 3 (bare SVG beats its PATH)");
  }

  // Fixture 4: the exact live DOM shape that caused the original bug — a
  // plain DIV (no cursor:pointer, no onclick, no tabindex, no role) > SVG >
  // PATH. Expected: PATH must still not win merely for being smallest; the
  // SVG (rank 7) outranks the generic wrapper (rank 8) and PATH (rank 9).
  {
    const path = new FakeElement("path", {
      rect: { top: 18, left: 283, right: 293, bottom: 24, width: 10, height: 6 },
    });
    const svg = new FakeElement("svg", {
      rect: { top: 14, left: 280, right: 296, bottom: 30, width: 16, height: 16 },
      children: [path],
    });
    const wrapper = new FakeElement("div", {
      // Deliberately NO cursor:pointer, NO onclick, NO tabindex, NO role —
      // the live DOM shape that defeated the original smallest-wins logic.
      rect: { top: 4, left: 260, right: 296, bottom: 40, width: 36, height: 36 },
      children: [svg],
    });
    const { body } = buildStrathberryModal({ closeTarget: wrapper });
    const result = resolveStrathberryCandidates(body);
    const top = acceptedOrderZero(result.candidates);
    assert.equal(result.found, true);
    assert.notEqual(path.getAttribute(STRATHBERRY_CANDIDATE_ATTR), "0", "Fixture 4: PATH must never be picked purely for being smallest");
    assert.ok(top && (top.tag === "svg" || top.tag === "div"), "Fixture 4: expected a safe SVG/wrapper pick, not PATH");
    console.log("  ok: Fixture 4 (no explicit interactivity anywhere — PATH still not blindly preferred)");
  }

  // Fixture 8: SHOP NOW must never appear as a selectable candidate.
  {
    const wrapper = new FakeElement("div", {
      style: { cursor: "pointer" },
      rect: { top: 4, left: 260, right: 296, bottom: 40, width: 36, height: 36 },
      children: [new FakeElement("svg", { children: [new FakeElement("path")] })],
    });
    const { body, shopNowButton } = buildStrathberryModal({ closeTarget: wrapper, includeShopNow: true });
    resolveStrathberryCandidates(body);
    assert.equal(shopNowButton?.getAttribute(STRATHBERRY_CANDIDATE_ATTR), null, "Fixture 8: SHOP NOW must never be selected");
    console.log("  ok: Fixture 8 (SHOP NOW never selected)");
  }

  // Fixture 9: the United States / country row must never be selected.
  {
    const wrapper = new FakeElement("div", {
      style: { cursor: "pointer" },
      rect: { top: 4, left: 260, right: 296, bottom: 40, width: 36, height: 36 },
      children: [new FakeElement("svg", { children: [new FakeElement("path")] })],
    });
    const { body, countryRow } = buildStrathberryModal({ closeTarget: wrapper, includeCountryRow: true });
    resolveStrathberryCandidates(body);
    assert.equal(countryRow?.getAttribute(STRATHBERRY_CANDIDATE_ATTR), null, "Fixture 9: country row must never be selected");
    console.log("  ok: Fixture 9 (country dropdown/United States never selected)");
  }

  // Fixture 10: a separate close "X" in the site header, outside the
  // confirmed modal, must never be selected — resolution never leaves the
  // confirmed overlay boundary.
  {
    const wrapper = new FakeElement("div", {
      style: { cursor: "pointer" },
      rect: { top: 4, left: 260, right: 296, bottom: 40, width: 36, height: 36 },
      children: [new FakeElement("svg", { children: [new FakeElement("path")] })],
    });
    const { body, headerX } = buildStrathberryModal({ closeTarget: wrapper, includeHeaderX: true });
    resolveStrathberryCandidates(body);
    assert.equal(headerX?.getAttribute(STRATHBERRY_CANDIDATE_ATTR), null, "Fixture 10: the header X must never be selected");
    console.log("  ok: Fixture 10 (header X outside the modal never selected)");
  }

  // Fixture 11: no safe X target exists anywhere in the modal (only SHOP
  // NOW and the country row — no icon at all). Expected: no candidate
  // found, nothing marked, safe failure rather than an arbitrary pick.
  {
    const { body, shopNowButton, countryRow } = buildStrathberryModal({});
    const result = resolveStrathberryCandidates(body);
    assert.equal(result.found, false, "Fixture 11: no safe target should be found");
    assert.equal(result.candidateCount, 0);
    assert.equal(shopNowButton?.getAttribute(STRATHBERRY_CANDIDATE_ATTR), null);
    assert.equal(countryRow?.getAttribute(STRATHBERRY_CANDIDATE_ATTR), null);
    console.log("  ok: Fixture 11 (no safe target anywhere — safe failure, no arbitrary click)");
  }

  // Fixtures 13-15: resolveStrathberryDialogPanelFn + true-panel-scoped
  // findStrathberryCloseCandidatesFn — reproduces the exact live DOM shape
  // reported after diagnostics: the generic overlay seed lands on a small
  // (294x41) "United States" country-selector button (whose own text
  // matches "ship(?:ping)? to"), containing an SVG with a "fa-chevron-down"
  // class, NOT the true modal. The true modal is a Headless UI dialog panel
  // (id starting "headlessui-dialog-panel-", suffix varies between runs)
  // nested inside outer wrapper divs that must never be mistaken for it,
  // containing the heading, UK-confirmation text, the country selector, and
  // a separate real close control.
  function buildTruePanelFixture(opts: {
    panelId?: string | null;
    chevronDecoyOutsideSeed?: boolean;
  }) {
    const chevronPath = new FakeElement("path", {
      rect: { top: 14, left: 264, right: 274, bottom: 20, width: 10, height: 6 },
    });
    const chevronSvg = new FakeElement("svg", {
      attrs: { class: "svg-inline--fa fa-chevron-down xyz" },
      rect: { top: 10, left: 260, right: 278, bottom: 26, width: 18, height: 16 },
      children: [chevronPath],
    });
    const countrySelector = new FakeElement("button", {
      // Own text matches "ship(?:ping)? to" — exactly what live evidence
      // showed caused the generic seed to land here instead of the panel.
      text: "Shipping to United States",
      rect: { top: 120, left: 4, right: 298, bottom: 161, width: 294, height: 41 },
      children: [chevronSvg],
    });

    const closePath = new FakeElement("path", {
      rect: { top: 6, left: 336, right: 344, bottom: 14, width: 8, height: 8 },
    });
    const closeSvg = new FakeElement("svg", {
      attrs: { class: "icon-close" },
      rect: { top: 2, left: 332, right: 348, bottom: 18, width: 16, height: 16 },
      children: [closePath],
    });
    const closeButton = new FakeElement("button", {
      rect: { top: 0, left: 328, right: 352, bottom: 20, width: 24, height: 20 },
      children: [closeSvg],
    });

    const panelChildren: FakeElement[] = [
      new FakeElement("h2", { text: "Shipping To United States?" }),
      new FakeElement("p", { text: "You are currently browsing our United Kingdom store." }),
      countrySelector,
      closeButton,
    ];

    if (opts.chevronDecoyOutsideSeed) {
      // A second, unrelated fa-chevron-down icon in the panel's top-right
      // zone, NOT inside the country selector — proves the class-based
      // exclusion works independently of the ancestor-seed exclusion.
      const decoyPath = new FakeElement("path", { rect: { top: 6, left: 300, right: 308, bottom: 12, width: 8, height: 6 } });
      const decoySvg = new FakeElement("svg", {
        attrs: { class: "fa-chevron-down" },
        rect: { top: 2, left: 296, right: 312, bottom: 18, width: 16, height: 16 },
        children: [decoyPath],
      });
      panelChildren.push(decoySvg);
    }

    const panelAttrs: Record<string, string> = {
      class:
        "max-w-lg relative w-full transform overflow-hidden pt-4 text-left align-middle shadow-xl transition-all bg-surface-secondary px-0 pb-0",
    };
    if (opts.panelId !== null) {
      panelAttrs.id = opts.panelId ?? "headlessui-dialog-panel-:r10:";
    }
    const truePanel = new FakeElement("div", {
      attrs: panelAttrs,
      rect: { top: 0, left: 0, right: 358, bottom: 403, width: 358, height: 403 },
      children: panelChildren,
    });

    const outerFlexWrapper = new FakeElement("div", {
      attrs: { class: "flex min-h-full items-center justify-center" },
      rect: { top: 0, left: 0, right: 390, bottom: 844, width: 390, height: 844 },
      children: [truePanel],
    });
    const outerFixedWrapper = new FakeElement("div", {
      attrs: { class: "fixed inset-0 overflow-y-auto" },
      rect: { top: 0, left: 0, right: 390, bottom: 844, width: 390, height: 844 },
      children: [outerFlexWrapper],
    });

    const header = new FakeElement("header", { text: "Strathberry" });
    const body = new FakeElement("body", { children: [header, outerFixedWrapper] });
    linkParents(body);

    return { body, truePanel, countrySelector, chevronSvg, closeButton, closeSvg, outerFlexWrapper, outerFixedWrapper };
  }

  const PANEL_MARK_ATTR = "data-kl-region-strathberry-panel";

  // Mirrors the live bug: the generic (locked, must-not-change)
  // findOverlayCandidateFn resolved the confirmed region-overlay seed to
  // the small country-selector button rather than the true panel. Marking
  // it directly here isolates these fixtures to what's actually under
  // test — resolveStrathberryDialogPanelFn's behavior given that (already
  // established, wrong) seed — without depending on findOverlayCandidateFn's
  // generic smallest-match-with-controls heuristic against this fixture's
  // exact geometry.
  function seedOnCountrySelector(body: FakeElement, countrySelector: FakeElement) {
    countrySelector.setAttribute(OVERLAY_ATTR, "true");
    return { document: makeFakeDocument(body) };
  }

  // Fixture 13: the generic seed lands on the country-selector button (point
  // 1); resolveStrathberryDialogPanelFn correctly resolves the TRUE
  // enclosing Headless UI panel via the id prefix (point 4), never the
  // outer wrapper divs or the country selector itself.
  {
    const { body, truePanel, countrySelector } = buildTruePanelFixture({});
    const { document } = seedOnCountrySelector(body, countrySelector);
    assert.equal(
      countrySelector.getAttribute(OVERLAY_ATTR),
      "true",
      "Fixture 13: reproduces the live bug — the seed lands on the country selector"
    );

    const resolvePanel = reconstructInBrowserLikeSandbox(__browserEvalPayloads.resolveStrathberryDialogPanelFn, document);
    const panelResult = resolvePanel({ seedAttr: OVERLAY_ATTR, panelMarkAttr: PANEL_MARK_ATTR });
    assert.equal(panelResult.panelFound, true, "Fixture 13: the true panel must be resolved");
    assert.equal(panelResult.resolutionStrategy, "headlessui-dialog-panel-id");
    assert.equal(truePanel.getAttribute(PANEL_MARK_ATTR), "true", "Fixture 13: the TRUE panel must be marked");
    assert.equal(
      countrySelector.getAttribute(PANEL_MARK_ATTR),
      null,
      "Fixture 13: the nested country-selector button must never be marked as the panel"
    );
    console.log("  ok: Fixture 13 (nested US button not mistaken for the true panel; resolved via headlessui id)");
  }

  // Fixture 14: Headless UI id suffix variation — the resolver must not
  // depend on any specific generated suffix.
  {
    const { body, truePanel, countrySelector } = buildTruePanelFixture({ panelId: "headlessui-dialog-panel-:r347:" });
    const { document } = seedOnCountrySelector(body, countrySelector);
    const resolvePanel = reconstructInBrowserLikeSandbox(__browserEvalPayloads.resolveStrathberryDialogPanelFn, document);
    const panelResult = resolvePanel({ seedAttr: OVERLAY_ATTR, panelMarkAttr: PANEL_MARK_ATTR });
    assert.equal(panelResult.panelFound, true, "Fixture 14: must resolve regardless of the exact id suffix");
    assert.equal(panelResult.resolutionStrategy, "headlessui-dialog-panel-id");
    assert.equal(truePanel.getAttribute(PANEL_MARK_ATTR), "true");
    console.log("  ok: Fixture 14 (Headless UI id suffix variation does not break resolution)");
  }

  // Fixture 15: no Headless UI id at all — structural/text fallback must
  // still resolve the true panel (not an outer wrapper) via shipping+UK
  // text combined with modal-sized geometry.
  {
    const { body, truePanel, countrySelector, outerFlexWrapper, outerFixedWrapper } = buildTruePanelFixture({ panelId: null });
    const { document } = seedOnCountrySelector(body, countrySelector);
    const resolvePanel = reconstructInBrowserLikeSandbox(__browserEvalPayloads.resolveStrathberryDialogPanelFn, document);
    const panelResult = resolvePanel({ seedAttr: OVERLAY_ATTR, panelMarkAttr: PANEL_MARK_ATTR });
    assert.equal(panelResult.panelFound, true, "Fixture 15: the text/size fallback must still find the panel");
    assert.equal(panelResult.resolutionStrategy, "text-and-size-heuristic");
    assert.equal(truePanel.getAttribute(PANEL_MARK_ATTR), "true", "Fixture 15: the true (innermost) panel must be picked");
    assert.equal(outerFlexWrapper.getAttribute(PANEL_MARK_ATTR), null, "Fixture 15: outer flex wrapper must never be picked");
    assert.equal(outerFixedWrapper.getAttribute(PANEL_MARK_ATTR), null, "Fixture 15: outer fixed wrapper must never be picked");
    console.log("  ok: Fixture 15 (structural/text fallback resolves the true panel, not an outer wrapper)");
  }

  // Fixture 16: close-control discovery scoped to the TRUE panel — proves
  // points 2/3/5/6/7/8/9: fa-chevron-down (and its path) are never treated
  // as close, the real close control (outside the country selector) is the
  // one selected, and the country selector / SHOP NOW-style wording is
  // never a candidate even when it sits inside the resolved panel boundary.
  {
    const { body, truePanel, countrySelector, chevronSvg, closeButton, closeSvg } = buildTruePanelFixture({
      chevronDecoyOutsideSeed: true,
    });
    const { document } = seedOnCountrySelector(body, countrySelector);

    const resolvePanel = reconstructInBrowserLikeSandbox(__browserEvalPayloads.resolveStrathberryDialogPanelFn, document);
    resolvePanel({ seedAttr: OVERLAY_ATTR, panelMarkAttr: PANEL_MARK_ATTR });
    assert.equal(truePanel.getAttribute(PANEL_MARK_ATTR), "true");

    const findCandidates = reconstructInBrowserLikeSandbox(__browserEvalPayloads.findStrathberryCloseCandidatesFn, document);
    const result = findCandidates({
      overlayAttr: PANEL_MARK_ATTR,
      markAttr: STRATHBERRY_CANDIDATE_ATTR,
      excludeFragments: STRATHBERRY_EXCLUDE_FRAGMENTS,
      excludeAncestorAttr: OVERLAY_ATTR,
    });

    assert.equal(result.found, true, "Fixture 16: a real close candidate must be found inside the true panel");
    const top = acceptedOrderZero(result.candidates);
    assert.equal(closeButton.getAttribute(STRATHBERRY_CANDIDATE_ATTR), "0", "Fixture 16: the real close control must be selected");
    assert.ok(top && (top.tag === "button" || top.tag === "svg"), "Fixture 16: expected the real close control to win");

    assert.equal(
      countrySelector.getAttribute(STRATHBERRY_CANDIDATE_ATTR),
      null,
      "Fixture 16: the US country-selector button must never be a candidate"
    );
    assert.equal(
      chevronSvg.getAttribute(STRATHBERRY_CANDIDATE_ATTR),
      null,
      "Fixture 16: the fa-chevron-down SVG must never be a candidate"
    );

    const countrySelectorDiag = result.candidates.find((c) => c.tag === "button" && c.insideCountrySelector);
    if (countrySelectorDiag) {
      assert.equal(countrySelectorDiag.accepted, false);
      assert.equal(countrySelectorDiag.rejectReason, "inside country selector control");
    }
    const chevronDiag = result.candidates.find((c) => c.hasChevronClass);
    if (chevronDiag) {
      assert.equal(chevronDiag.accepted, false);
      assert.ok(
        chevronDiag.rejectReason === "fa-chevron-down icon (country selector chevron)" ||
          chevronDiag.rejectReason === "inside country selector control"
      );
    }
    console.log(
      "  ok: Fixture 16 (fa-chevron-down and country selector explicitly excluded; real close control selected)"
    );
  }

  // Fixture 17: end-to-end dismissal — clicking the resolved real close
  // control (via the bounded retry, exactly as attemptStrathberryDismissal
  // wires it) dismisses the TRUE panel specifically, never the country
  // selector/dropdown, never SHOP NOW, and verification reports true.
  {
    const { body, truePanel, countrySelector, closeButton } = buildTruePanelFixture({});
    const { document } = seedOnCountrySelector(body, countrySelector);

    const resolvePanel = reconstructInBrowserLikeSandbox(__browserEvalPayloads.resolveStrathberryDialogPanelFn, document);
    resolvePanel({ seedAttr: OVERLAY_ATTR, panelMarkAttr: PANEL_MARK_ATTR });

    const findCandidates = reconstructInBrowserLikeSandbox(__browserEvalPayloads.findStrathberryCloseCandidatesFn, document);
    const result = findCandidates({
      overlayAttr: PANEL_MARK_ATTR,
      markAttr: STRATHBERRY_CANDIDATE_ATTR,
      excludeFragments: STRATHBERRY_EXCLUDE_FRAGMENTS,
      excludeAncestorAttr: OVERLAY_ATTR,
    });
    assert.equal(result.found, true);

    let usButtonClicked = false;
    let shopNowClicked = false;

    const dismissed = await attemptBoundedCandidateDismissal({
      candidateCount: result.candidateCount,
      click: async (index) => {
        const marked = truePanel
          .allDescendantsPublic()
          .find((el) => el.getAttribute(STRATHBERRY_CANDIDATE_ATTR) === String(index));
        if (!marked) return { success: false, error: "not found" };
        if (marked === countrySelector || countrySelector.allDescendantsPublic().includes(marked)) {
          usButtonClicked = true;
        }
        if (marked.innerText.toUpperCase().includes("SHOP NOW")) {
          shopNowClicked = true;
        }
        if (marked === closeButton || closeButton.allDescendantsPublic().includes(marked)) {
          // Simulate the real click actually removing/hiding the true panel.
          truePanel.hide();
        }
        return { success: true };
      },
      dispatchSecondaryClick: async () => {},
      isOverlayGone: async () => {
        const stillVisible = truePanel.style.display !== "none" && truePanel.getBoundingClientRect().width > 0;
        return !stillVisible;
      },
      sleep: async () => {},
    });

    assert.equal(dismissed, true, "Fixture 17: the real close click must dismiss the true panel");
    assert.equal(usButtonClicked, false, "Fixture 17: the US button must never be clicked");
    assert.equal(shopNowClicked, false, "Fixture 17: SHOP NOW must never be clicked");
    console.log("  ok: Fixture 17 (real close click dismisses the true panel; US button/SHOP NOW never clicked)");
  }

  // Fixture 12 (gate unchanged): covered by the existing
  // strathberryFallbackAppliesTo assertions below — that function was not
  // touched by this change, so "Shopping To ..." and "Shipping To ..."
  // continue to be accepted exactly as before.

  // Fixtures 5-7: attemptBoundedCandidateDismissal — the bounded,
  // injectable retry/verification algorithm, tested with fakes (no real
  // Page/browser needed, mirroring region-wait.ts's established pattern).

  // Fixture 5: the first safe candidate's click "succeeds" but never
  // actually dismisses the modal; the second candidate does. Expected: the
  // bounded retry tries candidate 2 and stops immediately on success.
  {
    let lastClickedIndex = -1;
    const clickCalls: number[] = [];
    const sleeps: number[] = [];
    const logs: string[] = [];
    const result = await attemptBoundedCandidateDismissal({
      candidateCount: 2,
      click: async (i) => {
        clickCalls.push(i);
        lastClickedIndex = i;
        return { success: true };
      },
      dispatchSecondaryClick: async () => {},
      isOverlayGone: async () => lastClickedIndex === 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: (m) => logs.push(m),
    });
    assert.equal(result, true, "Fixture 5: the bounded retry must succeed via the second candidate");
    assert.deepEqual(clickCalls, [0, 1], "Fixture 5: must try candidate 0 then candidate 1, and stop");
    assert.ok(logs.some((l) => l.includes("attempt 2") && l.includes("modalDisappeared=true")));
    console.log("  ok: Fixture 5 (first candidate fails to dismiss, second succeeds, retry stops immediately)");
  }

  // Fixture 6: the click succeeds and the modal disappears, but only after
  // a short asynchronous delay (e.g. a CSS transition). Expected:
  // verification polls (bounded) and returns true once it's actually gone.
  {
    let checkCalls = 0;
    const sleeps: number[] = [];
    const result = await attemptBoundedCandidateDismissal({
      candidateCount: 1,
      click: async () => ({ success: true }),
      dispatchSecondaryClick: async () => {},
      isOverlayGone: async () => {
        checkCalls++;
        return checkCalls >= 3; // gone only from the 3rd check onward
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(result, true, "Fixture 6: verification must wait for the delayed disappearance");
    assert.ok(sleeps.length >= 2, "Fixture 6: expected the poll loop to actually wait before succeeding");
    console.log("  ok: Fixture 6 (modal disappears asynchronously after a short delay — verification waits)");
  }

  // Fixture 7: the modal disappears immediately after the click, but has
  // reappeared by the time of the short reappear-check. Expected: reported
  // distinctly (modalReappeared=true, modalDisappeared=false) and NOT
  // treated as a successful dismissal.
  {
    let checkCalls = 0;
    const logs: string[] = [];
    const result = await attemptBoundedCandidateDismissal({
      candidateCount: 1,
      click: async () => ({ success: true }),
      dispatchSecondaryClick: async () => {},
      isOverlayGone: async () => {
        checkCalls++;
        // 1st check (immediately after click): gone. 2nd check (the
        // reappear check): back again.
        return checkCalls === 1;
      },
      sleep: async () => {},
      log: (m) => logs.push(m),
    });
    assert.equal(result, false, "Fixture 7: a reappearing modal must not count as a successful dismissal");
    assert.ok(
      logs.some((l) => l.includes("modalReappeared=true") && l.includes("modalDisappeared=false")),
      "Fixture 7: reappearance must be logged distinctly from a clean success or a plain failure"
    );
    console.log("  ok: Fixture 7 (modal disappears then reappears — reported distinctly, not treated as success)");
  }

  // 4. clearMarksFn: removes previously-set marker attributes.
  {
    const { body, overlayPanel } = buildStrathberryOverlayFixture();
    overlayPanel.setAttribute("data-kl-region-overlay", "true");
    const document = makeFakeDocument(body);
    const clearMarks = reconstructInBrowserLikeSandbox(__browserEvalPayloads.clearMarksFn, document);
    clearMarks("data-kl-region-overlay");
    assert.equal(overlayPanel.getAttribute("data-kl-region-overlay"), null);
    console.log("  ok: clearMarksFn");
  }

  // 5. getBodyInnerTextFn: plain sanity check.
  {
    const { body } = buildStrathberryOverlayFixture();
    const document = makeFakeDocument(body);
    const getBodyInnerText = reconstructInBrowserLikeSandbox(__browserEvalPayloads.getBodyInnerTextFn, document);
    assert.match(getBodyInnerText(undefined as never), /Shopping To United States/);
    console.log("  ok: getBodyInnerTextFn");
  }

  // 6. strathberryFallbackAppliesTo: the gate deciding whether the
  //    Strathberry-specific close fallback may run. Root-caused live
  //    failure: Strathberry's "Shipping To United States?" wording only
  //    matches the "ship(?:ping)? to" REGION_SIGNAL_SOURCES entry, not the
  //    "shopping to" ones, so the gate must also accept that pattern.
  {
    assert.equal(
      strathberryFallbackAppliesTo(["shopping to"]),
      true,
      '"shopping to" must trigger the fallback'
    );
    assert.equal(
      strathberryFallbackAppliesTo(["shopping to united states"]),
      true,
      '"shopping to united states" must trigger the fallback'
    );
    assert.equal(
      strathberryFallbackAppliesTo(["ship(?:ping)? to"]),
      true,
      '"ship(?:ping)? to" (the live "Shipping To ...?" match) must trigger the fallback'
    );
    assert.equal(
      strathberryFallbackAppliesTo(["ship(?:ping)? to", "currently browsing our united kingdom store"]),
      true,
      "must trigger when ship(?:ping)? to is present alongside other matched patterns (the exact live matchedPatterns)"
    );
    assert.equal(
      strathberryFallbackAppliesTo(["select (?:your )?(?:shipping )?country"]),
      false,
      "an unrelated generic region signal must NOT trigger this Strathberry-specific fallback"
    );
    assert.equal(
      strathberryFallbackAppliesTo(["currently browsing our united kingdom store"]),
      false,
      "the UK-confirmation signal alone (no shopping/shipping wording) must NOT trigger the fallback"
    );
    assert.equal(strathberryFallbackAppliesTo([]), false, "no matched patterns must NOT trigger the fallback");
    console.log(
      "  ok: strathberryFallbackAppliesTo (shopping to / shopping to united states / ship(?:ping)? to all trigger; unrelated signals don't)"
    );
  }

  console.log("All region.ts browser-evaluation regression tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
