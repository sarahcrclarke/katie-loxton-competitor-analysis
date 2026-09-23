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
import { __browserEvalPayloads } from "./region";

type FakeStyle = { visibility: string; display: string; opacity: string };
type FakeRect = { top: number; left: number; right: number; bottom: number; width: number; height: number };

class FakeElement {
  tagName: string;
  private attrs: Record<string, string>;
  private text: string;
  private rect: FakeRect;
  style: FakeStyle;
  children: FakeElement[];

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
    this.style = { visibility: "visible", display: "block", opacity: "1", ...(opts.style ?? {}) };
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
function buildStrathberryFallbackFixture() {
  const svgIcon = new FakeElement("svg", {
    rect: { top: 12, left: 272, right: 288, bottom: 28, width: 16, height: 16 },
    children: [new FakeElement("path")],
  });
  // No attrs at all: no role, no aria-label, no title, no tabindex, no
  // onclick — exactly the live DOM shape that defeated the generic
  // structural fallback.
  const iconWrapper = new FakeElement("div", {
    rect: { top: 4, left: 260, right: 296, bottom: 40, width: 36, height: 36 },
    children: [svgIcon],
  });
  const shopNowButton = new FakeElement("button", {
    text: "SHOP NOW",
    rect: { top: 200, left: 20, right: 280, bottom: 240, width: 260, height: 40 },
  });
  const countryRow = new FakeElement("div", {
    text: "United States",
    rect: { top: 120, left: 20, right: 280, bottom: 160, width: 260, height: 40 },
  });
  // Small, top-right-ish decoy with real CTA-like text, to prove the
  // exclusion-fragment check (not just size/position) is actually doing
  // work, not merely relying on SHOP NOW/country row being too large.
  const decoyYesChip = new FakeElement("span", {
    text: "Yes",
    rect: { top: 6, left: 230, right: 256, bottom: 30, width: 26, height: 24 },
  });
  const overlayPanel = new FakeElement("div", {
    rect: { top: 0, left: 0, right: 300, bottom: 260, width: 300, height: 260 },
    children: [
      new FakeElement("h2", { text: "Shopping To United States?" }),
      new FakeElement("p", { text: "You are currently browsing our United Kingdom store." }),
      countryRow,
      shopNowButton,
      decoyYesChip,
      iconWrapper,
    ],
  });
  // An unrelated close "X" that happens to exist elsewhere on the page
  // (e.g. a nav/menu close button), positioned well outside the overlay's
  // bounds and NOT a descendant of it — the fallback must never touch it.
  const unrelatedPageX = new FakeElement("button", {
    attrs: { "aria-label": "Close" },
    rect: { top: 4, left: 760, right: 796, bottom: 40, width: 36, height: 36 },
  });
  const header = new FakeElement("header", { text: "Strathberry" });
  const body = new FakeElement("body", { children: [header, overlayPanel, unrelatedPageX] });
  return {
    body,
    overlayPanel,
    iconWrapper,
    svgIcon,
    shopNowButton,
    countryRow,
    decoyYesChip,
    unrelatedPageX,
  };
}

function run() {
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

  // 3b. findStrathberryTopRightIconFn: the last-resort Strathberry fallback,
  //     for the live DOM shape where even the generic structural fallback
  //     fails — an SVG icon in a plain <div> with no button/role/aria-label/
  //     title/tabindex/onclick/cursor:pointer at all.
  {
    const {
      body,
      overlayPanel,
      iconWrapper,
      svgIcon,
      shopNowButton,
      countryRow,
      decoyYesChip,
      unrelatedPageX,
    } = buildStrathberryFallbackFixture();
    overlayPanel.setAttribute("data-kl-region-overlay", "true");
    const document = makeFakeDocument(body);

    // 1. Prove the generic structural fallback genuinely fails on this
    //    fixture first (it only looks at button/[role=button]/a, and the
    //    icon wrapper here is a plain, attribute-less <div>).
    const findStructuralCloseControl = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.findStructuralCloseControlFn,
      document
    );
    const genericFound = findStructuralCloseControl({
      overlayAttr: "data-kl-region-overlay",
      closeAttr: "data-kl-region-close",
    });
    assert.equal(genericFound, false, "the generic structural fallback must fail on this fixture");

    // 2. The Strathberry-specific fallback must find it instead.
    const findStrathberryTopRightIcon = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.findStrathberryTopRightIconFn,
      document
    );
    const result = findStrathberryTopRightIcon({
      overlayAttr: "data-kl-region-overlay",
      closeAttr: "data-kl-strathberry-close",
      excludeFragments: ["shop now", "united states", "continue", "yes", "country", "dropdown"],
    });

    assert.equal(result.found, true, "the Strathberry fallback must find the icon/wrapper close control");
    const markedOnIcon = svgIcon.getAttribute("data-kl-strathberry-close") === "true";
    const markedOnWrapper = iconWrapper.getAttribute("data-kl-strathberry-close") === "true";
    assert.ok(markedOnIcon || markedOnWrapper, "expected the SVG icon or its wrapper to be marked as the close control");

    // 3-5. Never SHOP NOW, never United States, never the unrelated
    //      page-level close X outside the modal.
    assert.equal(shopNowButton.getAttribute("data-kl-strathberry-close"), null, "must never select SHOP NOW");
    assert.equal(countryRow.getAttribute("data-kl-strathberry-close"), null, "must never select United States");
    assert.equal(
      decoyYesChip.getAttribute("data-kl-strathberry-close"),
      null,
      "must never select a small CTA-like 'Yes' chip"
    );
    assert.equal(
      unrelatedPageX.getAttribute("data-kl-strathberry-close"),
      null,
      "must never select a close X outside the confirmed overlay"
    );

    // Diagnostics: confirm elements were actually inspected and reported.
    assert.ok(result.inspectedCount > 0, "expected at least one element to be reported as inspected");
    assert.ok(result.candidates.length > 0, "expected at least one top-right candidate in diagnostics");
    const chosenCandidates = result.candidates.filter((c) => c.chosen);
    assert.equal(chosenCandidates.length, 1, "exactly one candidate should be marked chosen");

    // 6-7. Simulate the click's effect and confirm a full re-scan of the
    //      page would now report the overlay gone — i.e. the orchestrator
    //      (confirmUkRegion) would report "uk-modal-dismissed" here.
    overlayPanel.hide();
    const isRegionSignalVisibleAfter = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.isRegionSignalVisibleFn,
      document
    );
    assert.equal(
      isRegionSignalVisibleAfter([
        "shopping to",
        "currently browsing our united kingdom store",
        "shopping to united states",
      ]),
      false,
      "after the click's effect, the region signal must no longer be visible (uk-modal-dismissed)"
    );

    console.log(
      "  ok: findStrathberryTopRightIconFn (generic fallback fails, Strathberry fallback finds the icon and not SHOP NOW/United States/decoys/unrelated X, dismissal verified)"
    );
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

  console.log("All region.ts browser-evaluation regression tests passed.");
}

run();
