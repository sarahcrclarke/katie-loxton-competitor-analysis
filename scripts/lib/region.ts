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
// currency/store-switch prompt". Regex *sources* (no literal RegExp
// objects) so the same list can be shipped into page.evaluate(), which
// runs in the browser and cannot see Node-side closures. Lowercase,
// used with the "i" flag. Includes Strathberry's known wording
// ("Shopping To ...") alongside more generic equivalents so this stays
// reusable for other competitors.
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

/**
 * Browser-side visibility check shared by the detection helpers below.
 * Deliberately plain JS (no outer closures) since it runs inside
 * page.evaluate().
 */
const VISIBLE_CHECK_SOURCE = `
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }
`;

/** True if any strong region/store-switch text is currently visible anywhere on the page. */
async function isRegionSignalVisible(page: Page): Promise<boolean> {
  return page.evaluate(
    ({ patternSources }) => {
      const isVisible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        if (parseFloat(style.opacity) === 0) return false;
        return true;
      };
      const elements = Array.from(document.querySelectorAll("body *"));
      for (const el of elements) {
        if (!isVisible(el)) continue;
        const text = (el as HTMLElement).innerText?.trim();
        if (!text) continue;
        for (const src of patternSources) {
          if (new RegExp(src, "i").test(text)) return true;
        }
      }
      return false;
    },
    { patternSources: REGION_SIGNAL_SOURCES }
  );
}

/**
 * Searches all VISIBLE text on the page (not role/id/class) for a strong
 * region/store-switch signal, then marks the smallest visible element
 * whose text contains it — the tightest wrapper around the signal, i.e.
 * the overlay/panel itself rather than <body> or a large ancestor.
 */
async function findRegionOverlayCandidate(
  page: Page
): Promise<{ locator: Locator; text: string; matchedPatterns: string[] } | null> {
  await page.evaluate((attr) => {
    document
      .querySelectorAll(`[${attr}]`)
      .forEach((el) => el.removeAttribute(attr));
  }, OVERLAY_MARK_ATTR);

  const result = await page.evaluate(
    ({ patternSources, attr }) => {
      const isVisible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        if (parseFloat(style.opacity) === 0) return false;
        return true;
      };

      const elements = Array.from(document.querySelectorAll("body *"));
      const matches: { el: Element; text: string; area: number; pattern: string }[] = [];

      for (const el of elements) {
        if (!isVisible(el)) continue;
        const text = (el as HTMLElement).innerText?.trim();
        if (!text) continue;
        for (const src of patternSources) {
          if (new RegExp(src, "i").test(text)) {
            const rect = el.getBoundingClientRect();
            matches.push({ el, text, area: rect.width * rect.height, pattern: src });
            break;
          }
        }
      }

      if (matches.length === 0) return null;
      matches.sort((a, b) => a.area - b.area);
      const chosen = matches[0];
      chosen.el.setAttribute(attr, "true");
      return {
        text: chosen.text,
        matchedPatterns: [...new Set(matches.map((m) => m.pattern))],
      };
    },
    { patternSources: REGION_SIGNAL_SOURCES, attr: OVERLAY_MARK_ATTR }
  );

  if (!result) return null;
  return {
    locator: page.locator(`[${OVERLAY_MARK_ATTR}="true"]`).first(),
    text: result.text,
    matchedPatterns: result.matchedPatterns,
  };
}

/**
 * Structural fallback for an icon-only close control (no accessible name)
 * positioned near the top-right corner of the already-confirmed overlay.
 * Only runs within that specific overlay element — never globally.
 */
async function findStructuralCloseControl(page: Page): Promise<Locator | null> {
  const found = await page.evaluate(
    ({ overlayAttr, closeAttr }) => {
      const container = document.querySelector(`[${overlayAttr}="true"]`);
      if (!container) return false;
      const containerRect = container.getBoundingClientRect();
      const marginX = Math.max(24, containerRect.width * 0.2);
      const marginY = Math.max(24, containerRect.height * 0.2);

      const candidates = Array.from(
        container.querySelectorAll('button, [role="button"], a')
      );
      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Icon-sized controls only — a full "SHOP NOW" style CTA is wider/taller.
        if (rect.width > 60 || rect.height > 60) continue;
        const isTopRight =
          rect.right >= containerRect.right - marginX &&
          rect.top <= containerRect.top + marginY;
        if (!isTopRight) continue;

        const accessibleName = (
          el.getAttribute("aria-label") ||
          (el as HTMLElement).innerText ||
          ""
        ).trim();
        // Only pick genuinely icon-only controls (no meaningful label) —
        // a labelled button ("United States", "Shop Now") is never this.
        if (accessibleName.length > 3) continue;

        el.setAttribute(closeAttr, "true");
        return true;
      }
      return false;
    },
    { overlayAttr: OVERLAY_MARK_ATTR, closeAttr: CLOSE_MARK_ATTR }
  );

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
    bodyText = await page.evaluate(() => document.body.innerText);
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
