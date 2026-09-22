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

    if (selector === "body *") return pool;

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
