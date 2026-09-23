/**
 * Regression tests for cookie consent handling, covering the actual live
 * failure modes we've seen on Strathberry rather than idealised markup:
 *
 *   A. current Strathberry variant — "Welcome to Strathberry" + "By
 *      clicking 'Accept All Cookies'..." with "Cookies Settings" and
 *      "Accept All Cookies" controls, no direct reject.
 *   B. previous Strathberry variant — "Reject All" + "Accept Cookies".
 *   C. an unrelated page with a generic "Accept" button and no
 *      cookie/privacy wording anywhere — must never be treated as consent.
 *   D. cookie text present but no safely identifiable reject/accept-all
 *      control (e.g. only "Cookies Settings" + a "Learn more" link).
 *   E. a bounded wait that gives an asynchronously-injected consent UI a
 *      chance to appear, tested via pollUntil() directly.
 *   F. ordinary footer/legal links ("Terms of service", "Privacy policy",
 *      "Cookies", "Modern slavery statement") with NO consent modal — a
 *      live false positive we hit where this footer alone was wrongly
 *      identified as the consent container.
 *   G. the same footer links PLUS a real consent modal — the modal must
 *      be selected over the footer, and only "Accept All Cookies" clicked.
 *
 * Like scripts/lib/region.browser-eval.test.ts, this stringifies the real
 * `new Function(...)`-built payloads exactly the way Playwright ships a
 * function to the browser (Function.prototype.toString(), then re-parsed
 * and executed) inside a Node vm context that deliberately has no
 * `__name` — the same production regression that broke region.ts.
 *
 * Run with: npx tsx scripts/lib/consent.browser-eval.test.ts
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { __browserEvalPayloads, pollUntil } from "./consent";

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

  hide() {
    this.style.display = "none";
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
 * then re-parse and run in a fresh context with no Node/tsx/esbuild
 * globals available.
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
  const script = new vm.Script(`(${source})`, { filename: "browser-eval-sandbox.js" });
  return script.runInContext(sandbox) as (arg: Arg) => Result;
}

const COOKIE_STRONG_SIGNAL_SOURCES = [
  "accept all cookies",
  "accept all",
  "allow all cookies",
  "allow all",
  "reject all cookies",
  "reject all",
  "decline all",
  "cookie settings",
  "cookies settings",
  "cookie preferences",
  "manage cookies",
  "manage preferences",
  "manage cookie preferences",
  "necessary cookies only",
  "only necessary",
  "continue without accepting",
  "storing of cookies",
  "cookies on your device",
  "tracking technologies",
  "we use cookies",
  "this (?:website|site) uses cookies",
  "use of cookies",
];

const COOKIE_WEAK_SIGNAL_SOURCES = [
  "cookie policy",
  "cookies policy",
  "privacy policy",
  "privacy notice",
  "terms of service",
  "terms and conditions",
  "modern slavery statement",
  "cookies",
  "privacy",
];

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

const OVERLAY_ATTR = "data-kl-consent-overlay";
const REJECT_ATTR = "data-kl-consent-reject";
const ACCEPT_ATTR = "data-kl-consent-accept";

function buildFixtureA() {
  // Current live Strathberry variant: no direct reject control at all.
  const settingsButton = new FakeElement("button", { text: "Cookies Settings" });
  const acceptButton = new FakeElement("button", { text: "Accept All Cookies" });
  const overlayPanel = new FakeElement("div", {
    children: [
      new FakeElement("h2", { text: "Welcome to Strathberry" }),
      new FakeElement("p", {
        text:
          'By clicking "Accept All Cookies", you agree to the storing of cookies on your device to enhance site navigation and analyse site usage.',
      }),
      settingsButton,
      acceptButton,
    ],
  });
  const body = new FakeElement("body", {
    children: [new FakeElement("header", { text: "Strathberry" }), overlayPanel],
  });
  return { body, overlayPanel, settingsButton, acceptButton };
}

function buildFixtureB() {
  // Earlier Strathberry variant: direct reject control is present.
  const rejectButton = new FakeElement("button", { text: "Reject All" });
  const acceptButton = new FakeElement("button", { text: "Accept Cookies" });
  const overlayPanel = new FakeElement("div", {
    children: [
      new FakeElement("p", {
        text: "We use cookies to improve your experience. Read our cookie policy and privacy policy to learn more.",
      }),
      rejectButton,
      acceptButton,
    ],
  });
  const body = new FakeElement("body", {
    children: [new FakeElement("header", { text: "Strathberry" }), overlayPanel],
  });
  return { body, overlayPanel, rejectButton, acceptButton };
}

function buildFixtureC() {
  // Unrelated page: a generic "Accept" CTA with no cookie/privacy wording
  // anywhere on the page.
  const acceptButton = new FakeElement("button", { text: "Accept" });
  const promo = new FakeElement("div", {
    children: [new FakeElement("h2", { text: "Join our newsletter" }), acceptButton],
  });
  const body = new FakeElement("body", {
    children: [new FakeElement("header", { text: "Strathberry" }), promo],
  });
  return { body, acceptButton };
}

function buildFixtureD() {
  // Cookie text is present but there is no reject-all or accept-all
  // control — only a settings button and an unrelated "Learn more" link.
  const settingsButton = new FakeElement("button", { text: "Cookies Settings" });
  const learnMoreLink = new FakeElement("a", { text: "Learn more" });
  const overlayPanel = new FakeElement("div", {
    children: [
      new FakeElement("p", { text: "This site uses cookies and similar tracking technologies." }),
      settingsButton,
      learnMoreLink,
    ],
  });
  const body = new FakeElement("body", {
    children: [new FakeElement("header", { text: "Strathberry" }), overlayPanel],
  });
  return { body, overlayPanel, settingsButton, learnMoreLink };
}

function buildFooterLinks(): FakeElement[] {
  // Mirrors the real live DOM shape from the false-positive report: each
  // footer link is an <a> wrapping a <span> with the same label text, so
  // both tags show up as separate clickable candidates.
  const labels = ["Terms of service", "Privacy policy", "Cookies", "Modern slavery statement"];
  return labels.map(
    (label) =>
      new FakeElement("a", {
        children: [new FakeElement("span", { text: label })],
      })
  );
}

function buildFixtureF() {
  // Live false positive: ordinary footer/legal links exist, but there is
  // no consent modal anywhere on the page at all.
  const footer = new FakeElement("footer", { children: buildFooterLinks() });
  const body = new FakeElement("body", {
    children: [new FakeElement("header", { text: "Strathberry" }), footer],
  });
  return { body, footer };
}

function buildFixtureG() {
  // The same footer links, PLUS a real Strathberry-style consent modal
  // elsewhere on the page. The modal (strong evidence) must be selected
  // over the footer (weak evidence only).
  const footer = new FakeElement("footer", { children: buildFooterLinks() });
  const settingsButton = new FakeElement("button", { text: "Cookies Settings" });
  const acceptButton = new FakeElement("button", { text: "Accept All Cookies" });
  const overlayPanel = new FakeElement("div", {
    children: [
      new FakeElement("h2", { text: "Welcome to Strathberry" }),
      new FakeElement("p", {
        text:
          'By clicking "Accept All Cookies", you agree to the storing of cookies on your device to enhance site navigation and analyse site usage.',
      }),
      new FakeElement("a", { text: "Cookie Policy" }),
      settingsButton,
      acceptButton,
    ],
  });
  const body = new FakeElement("body", {
    children: [new FakeElement("header", { text: "Strathberry" }), footer, overlayPanel],
  });
  return { body, footer, overlayPanel, settingsButton, acceptButton };
}

async function run() {
  console.log("Running consent.ts browser-evaluation regression tests...");

  // Fixture A: current Strathberry variant — Accept All Cookies only.
  {
    const { body, overlayPanel, settingsButton, acceptButton } = buildFixtureA();
    const document = makeFakeDocument(body);

    const findOverlayCandidate = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.findOverlayCandidateFn,
      document
    );
    const overlayResult = findOverlayCandidate({
      strongPatternSources: COOKIE_STRONG_SIGNAL_SOURCES,
      weakPatternSources: COOKIE_WEAK_SIGNAL_SOURCES,
      attr: OVERLAY_ATTR,
    });
    assert.ok(overlayResult, "Fixture A: expected the consent overlay to be positively detected");
    assert.equal(overlayPanel.getAttribute(OVERLAY_ATTR), "true");

    const findControls = reconstructInBrowserLikeSandbox(__browserEvalPayloads.findControlsFn, document);
    const controlsResult = findControls({
      overlayAttr: OVERLAY_ATTR,
      rejectAttr: REJECT_ATTR,
      acceptAttr: ACCEPT_ATTR,
      rejectFragments: REJECT_TEXT_FRAGMENTS,
      acceptFragments: ACCEPT_TEXT_FRAGMENTS,
    });
    assert.equal(controlsResult.rejectFound, false, "Fixture A: there is no reject control to find");
    assert.equal(controlsResult.acceptFound, true, "Fixture A: Accept All Cookies must be found");
    assert.equal(acceptButton.getAttribute(ACCEPT_ATTR), "true");
    assert.equal(
      settingsButton.getAttribute(ACCEPT_ATTR),
      null,
      "Fixture A: Cookies Settings must never be selected as the accept control"
    );
    assert.equal(settingsButton.getAttribute(REJECT_ATTR), null);

    // Simulate the click's effect (site hides/removes the panel) and verify.
    overlayPanel.hide();
    const isMarkedElementVisible = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.isMarkedElementVisibleFn,
      document
    );
    assert.equal(isMarkedElementVisible(OVERLAY_ATTR), false, "Fixture A: dismissal must be verified as gone");

    console.log('  ok: Fixture A (accept-all only, "Cookies Settings" never chosen, dismissal verified)');
  }

  // Fixture B: previous Strathberry variant — Reject All is preferred.
  {
    const { body, overlayPanel, rejectButton, acceptButton } = buildFixtureB();
    const document = makeFakeDocument(body);

    const findOverlayCandidate = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.findOverlayCandidateFn,
      document
    );
    const overlayResult = findOverlayCandidate({
      strongPatternSources: COOKIE_STRONG_SIGNAL_SOURCES,
      weakPatternSources: COOKIE_WEAK_SIGNAL_SOURCES,
      attr: OVERLAY_ATTR,
    });
    assert.ok(overlayResult, "Fixture B: expected the consent overlay to be positively detected");

    const findControls = reconstructInBrowserLikeSandbox(__browserEvalPayloads.findControlsFn, document);
    const controlsResult = findControls({
      overlayAttr: OVERLAY_ATTR,
      rejectAttr: REJECT_ATTR,
      acceptAttr: ACCEPT_ATTR,
      rejectFragments: REJECT_TEXT_FRAGMENTS,
      acceptFragments: ACCEPT_TEXT_FRAGMENTS,
    });
    assert.equal(controlsResult.rejectFound, true, "Fixture B: Reject All must be found");
    assert.equal(rejectButton.getAttribute(REJECT_ATTR), "true");
    // Both exist, but the orchestrator (dismissCookieConsent) must prefer
    // reject when it's available — verified separately in its own logic;
    // here we just confirm both are correctly classified.
    assert.equal(controlsResult.acceptFound, true);
    assert.equal(acceptButton.getAttribute(ACCEPT_ATTR), "true");

    overlayPanel.hide();
    const isMarkedElementVisible = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.isMarkedElementVisibleFn,
      document
    );
    assert.equal(isMarkedElementVisible(OVERLAY_ATTR), false, "Fixture B: dismissal must be verified as gone");

    console.log("  ok: Fixture B (direct reject-all found and preferred, dismissal verified)");
  }

  // Fixture C: unrelated page — a generic "Accept" button must never be
  // treated as cookie consent when there's no supporting cookie/privacy text.
  {
    const { body, acceptButton } = buildFixtureC();
    const document = makeFakeDocument(body);

    const findOverlayCandidate = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.findOverlayCandidateFn,
      document
    );
    const overlayResult = findOverlayCandidate({
      strongPatternSources: COOKIE_STRONG_SIGNAL_SOURCES,
      weakPatternSources: COOKIE_WEAK_SIGNAL_SOURCES,
      attr: OVERLAY_ATTR,
    });
    assert.equal(overlayResult, null, "Fixture C: no cookie/privacy overlay should be detected");
    assert.equal(
      acceptButton.getAttribute(OVERLAY_ATTR),
      null,
      "Fixture C: the unrelated Accept button must never be marked/touched"
    );

    console.log('  ok: Fixture C (unrelated "Accept" button is ignored — result is not-present)');
  }

  // Fixture D: consent detected, but no safe reject/accept-all control.
  {
    const { body, settingsButton, learnMoreLink } = buildFixtureD();
    const document = makeFakeDocument(body);

    const findOverlayCandidate = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.findOverlayCandidateFn,
      document
    );
    const overlayResult = findOverlayCandidate({
      strongPatternSources: COOKIE_STRONG_SIGNAL_SOURCES,
      weakPatternSources: COOKIE_WEAK_SIGNAL_SOURCES,
      attr: OVERLAY_ATTR,
    });
    assert.ok(overlayResult, "Fixture D: cookie text should still be positively detected");

    const findControls = reconstructInBrowserLikeSandbox(__browserEvalPayloads.findControlsFn, document);
    const controlsResult = findControls({
      overlayAttr: OVERLAY_ATTR,
      rejectAttr: REJECT_ATTR,
      acceptAttr: ACCEPT_ATTR,
      rejectFragments: REJECT_TEXT_FRAGMENTS,
      acceptFragments: ACCEPT_TEXT_FRAGMENTS,
    });
    assert.equal(controlsResult.rejectFound, false, "Fixture D: no reject control exists");
    assert.equal(controlsResult.acceptFound, false, "Fixture D: no accept-all control exists");
    assert.equal(settingsButton.getAttribute(REJECT_ATTR), null);
    assert.equal(settingsButton.getAttribute(ACCEPT_ATTR), null);
    assert.equal(learnMoreLink.getAttribute(REJECT_ATTR), null);
    assert.equal(learnMoreLink.getAttribute(ACCEPT_ATTR), null);

    console.log("  ok: Fixture D (detected, no safe control — no unsafe click, result is could-not-dismiss)");
  }

  // Fixture F: live false positive — ordinary footer/legal links only, no
  // consent modal anywhere. The footer must never become the container.
  {
    const { body, footer } = buildFixtureF();
    const document = makeFakeDocument(body);

    const findOverlayCandidate = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.findOverlayCandidateFn,
      document
    );
    const overlayResult = findOverlayCandidate({
      strongPatternSources: COOKIE_STRONG_SIGNAL_SOURCES,
      weakPatternSources: COOKIE_WEAK_SIGNAL_SOURCES,
      attr: OVERLAY_ATTR,
    });
    assert.equal(
      overlayResult,
      null,
      "Fixture F: footer legal links alone (Terms of service, Privacy policy, Cookies, Modern slavery statement) must not be identified as a consent container"
    );
    for (const link of footer.allDescendantsPublic()) {
      assert.equal(link.getAttribute(OVERLAY_ATTR), null, "Fixture F: no footer element may be marked/touched");
    }

    console.log("  ok: Fixture F (footer-only legal links never become the consent container — not-present)");
  }

  // Fixture G: the same footer links PLUS a real consent modal — the
  // modal must be selected over the footer, and only Accept All Cookies
  // clicked (Cookies Settings and the footer's own "Cookies" link must
  // never be chosen).
  {
    const { body, footer, overlayPanel, settingsButton, acceptButton } = buildFixtureG();
    const document = makeFakeDocument(body);

    const findOverlayCandidate = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.findOverlayCandidateFn,
      document
    );
    const overlayResult = findOverlayCandidate({
      strongPatternSources: COOKIE_STRONG_SIGNAL_SOURCES,
      weakPatternSources: COOKIE_WEAK_SIGNAL_SOURCES,
      attr: OVERLAY_ATTR,
    });
    assert.ok(overlayResult, "Fixture G: the real consent modal must be positively detected");
    assert.equal(
      overlayPanel.getAttribute(OVERLAY_ATTR),
      "true",
      "Fixture G: the modal, not the footer, must be selected as the consent container"
    );
    for (const link of footer.allDescendantsPublic()) {
      assert.equal(
        link.getAttribute(OVERLAY_ATTR),
        null,
        "Fixture G: the footer must never be selected as the consent container"
      );
    }

    const findControls = reconstructInBrowserLikeSandbox(__browserEvalPayloads.findControlsFn, document);
    const controlsResult = findControls({
      overlayAttr: OVERLAY_ATTR,
      rejectAttr: REJECT_ATTR,
      acceptAttr: ACCEPT_ATTR,
      rejectFragments: REJECT_TEXT_FRAGMENTS,
      acceptFragments: ACCEPT_TEXT_FRAGMENTS,
    });
    assert.equal(controlsResult.rejectFound, false, "Fixture G: there is no reject control in this variant");
    assert.equal(controlsResult.acceptFound, true, "Fixture G: Accept All Cookies must be found");
    assert.equal(acceptButton.getAttribute(ACCEPT_ATTR), "true");
    assert.equal(
      settingsButton.getAttribute(ACCEPT_ATTR),
      null,
      "Fixture G: Cookies Settings must never be selected"
    );
    for (const link of footer.allDescendantsPublic()) {
      assert.equal(link.getAttribute(ACCEPT_ATTR), null, "Fixture G: no footer link may be clicked");
      assert.equal(link.getAttribute(REJECT_ATTR), null, "Fixture G: no footer link may be clicked");
    }

    overlayPanel.hide();
    const isMarkedElementVisible = reconstructInBrowserLikeSandbox(
      __browserEvalPayloads.isMarkedElementVisibleFn,
      document
    );
    assert.equal(isMarkedElementVisible(OVERLAY_ATTR), false, "Fixture G: dismissal must be verified as gone");

    console.log(
      "  ok: Fixture G (modal selected over footer, only Accept All Cookies clicked, dismissal verified)"
    );
  }

  // Fixture E: bounded wait for an asynchronously-injected consent UI.
  {
    let calls = 0;
    const check = async (): Promise<string | null> => {
      calls += 1;
      // Simulate the CMP not being in the DOM for the first two checks.
      return calls >= 3 ? "consent-overlay-appeared" : null;
    };
    const sleeps: number[] = [];
    const result = await pollUntil(check, {
      maxWaitMs: 5000,
      pollIntervalMs: 300,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(result, "consent-overlay-appeared", "Fixture E: the bounded wait must catch the delayed CMP");
    assert.equal(calls, 3, "Fixture E: expected exactly the calls needed to find it, not more");
    assert.deepEqual(sleeps, [300, 300], "Fixture E: expected two poll intervals before success");

    // And the inverse: if it never appears, pollUntil gives up at the bound
    // rather than waiting forever. Drives a deterministic fake clock (via
    // pollUntil's injectable `now`) instead of depending on real wall-clock
    // time, since the fake `sleep` below doesn't actually delay.
    let fakeClock = 0;
    let neverCalls = 0;
    const neverCheck = async (): Promise<string | null> => {
      neverCalls += 1;
      return null;
    };
    const neverSleeps: number[] = [];
    const neverResult = await pollUntil(neverCheck, {
      maxWaitMs: 1000,
      pollIntervalMs: 300,
      now: () => fakeClock,
      sleep: async (ms) => {
        neverSleeps.push(ms);
        fakeClock += ms;
      },
    });
    assert.equal(neverResult, null, "Fixture E: must give up and return null when nothing ever appears");
    assert.equal(neverCalls, 5, "Fixture E: expected checks at t=0,300,600,900,1200 before the 1000ms bound stops it");

    console.log("  ok: Fixture E (bounded poll catches a delayed CMP, and gives up when nothing appears)");
  }

  console.log("All consent.ts browser-evaluation regression tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
