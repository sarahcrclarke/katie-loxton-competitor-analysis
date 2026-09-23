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
