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

type FakeStyle = { visibility: string; display: string; opacity: string; cursor: string };
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
    this.style = {
      visibility: "visible",
      display: "block",
      opacity: "1",
      cursor: "auto",
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

  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
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
      return pool.filter((el) => el.hasAttribute(attrOnlyMatch[1]));
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

/**
 * Models the real Strathberry close control as reported live: an SVG "X"
 * icon with no text/attributes at all, nested inside a plain <div> wrapper
 * that has neither an accessible role/name nor an onclick attribute — its
 * only sign of being clickable is a computed `cursor: pointer` style (as a
 * CSS-class-driven click target would have in a real browser). This is
 * exactly the DOM shape the previous button/[role=button]/a-only
 * structural fallback could not find.
 */
function buildStrathberryOverlayFixture() {
  const closeIcon = new FakeElement("svg", {
    rect: { top: 12, left: 272, right: 288, bottom: 28, width: 16, height: 16 },
  });
  const closeWrapper = new FakeElement("div", {
    style: { cursor: "pointer" },
    rect: { top: 4, left: 260, right: 296, bottom: 40, width: 36, height: 36 },
    children: [closeIcon],
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
      closeWrapper,
    ],
  });
  const header = new FakeElement("header", { text: "Strathberry" });
  const body = new FakeElement("body", { children: [header, overlayPanel] });
  return { body, overlayPanel, closeWrapper, closeIcon, shopNowButton };
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

  // 3. findStructuralCloseControlFn: finds the SVG-icon-in-a-plain-div close
  //    control (no button/role/aria-label — only a computed pointer cursor
  //    marks it as clickable), never the labelled "SHOP NOW" button, and
  //    reports every candidate it considered for diagnostics.
  {
    const { body, overlayPanel, closeWrapper, closeIcon, shopNowButton } =
      buildStrathberryOverlayFixture();
    overlayPanel.setAttribute("data-kl-region-overlay", "true");
    const document = makeFakeDocument(body);
    const findStructuralCloseControl = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.findStructuralCloseControlFn,
      document
    );
    const result = findStructuralCloseControl({
      overlayAttr: "data-kl-region-overlay",
      closeAttr: "data-kl-region-close",
      ctaExcludeFragments: ["shop now", "continue", "united states", "yes"],
    });

    assert.equal(result.found, true);
    // Either the icon or its pointer-cursor wrapper is an acceptable pick —
    // both live inside the same 36x36 top-right close target.
    const markedOnIcon = closeIcon.getAttribute("data-kl-region-close") === "true";
    const markedOnWrapper = closeWrapper.getAttribute("data-kl-region-close") === "true";
    assert.ok(markedOnIcon || markedOnWrapper, "expected the icon or its wrapper to be marked as the close control");
    assert.equal(
      shopNowButton.getAttribute("data-kl-region-close"),
      null,
      "SHOP NOW must never be marked as the close control"
    );

    // Diagnostics: SHOP NOW must be reported but never chosen; the actual
    // close target must be reported and chosen.
    const shopNowCandidate = result.candidates.find((c) => c.accessibleName === "SHOP NOW");
    assert.ok(shopNowCandidate, "expected SHOP NOW to appear in the diagnostics candidates");
    assert.equal(shopNowCandidate!.chosen, false);

    const chosenCandidates = result.candidates.filter((c) => c.chosen);
    assert.equal(chosenCandidates.length, 1, "exactly one candidate should be marked chosen");
    assert.ok(
      chosenCandidates[0].tag === "svg" || chosenCandidates[0].tag === "div",
      `expected the chosen candidate to be the icon or its wrapper, got tag=${chosenCandidates[0].tag}`
    );

    console.log(
      "  ok: findStructuralCloseControlFn (finds SVG-in-plain-div close control via cursor:pointer, not SHOP NOW, with diagnostics)"
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
