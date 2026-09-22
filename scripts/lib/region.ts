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

// This monitoring project is UK-only, so we only ever need to recognise
// "you're on the UK store, want to switch?" style prompts and keep the UK
// storefront — never a general-purpose country picker.
const UK_CONFIRMATION_PATTERN = /united kingdom/i;

// Text that indicates an overlay is about country/region/location/currency
// selection at all (as opposed to some unrelated dialog on the page).
const REGION_SIGNAL_PATTERN =
  /shopping (to|from)|currently (shopping|browsing)|select your (country|region)|choose your (country|region|store)|ship(ping)? to|switch (store|country|region)|continue (to|on) (our )?[a-z\s]+ (site|store)|currency/i;

// Accessible-role dialog selectors are preferred; the attribute-based
// selectors are only a fallback for sites that build an overlay without a
// proper dialog role.
const REGION_CONTAINER_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[id*="country" i]',
  '[class*="country" i]',
  '[id*="region" i]',
  '[class*="region" i]',
  '[id*="geo" i]',
  '[class*="geo" i]',
  '[id*="location" i]',
  '[class*="location" i]',
  '[id*="currency" i]',
  '[class*="currency" i]',
];

// A control that closes/dismisses the overlay while staying on the current
// store — never a "shop now" / "continue" / "yes" style switch action.
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

async function findCloseOrStayControl(
  container: Locator
): Promise<Locator | null> {
  const candidates = [
    container.getByRole("button", { name: CLOSE_OR_STAY_TEXT_PATTERN }).first(),
    container.locator('[aria-label*="close" i], [aria-label*="dismiss" i]').first(),
    container
      .locator('button, a[role="button"], [role="button"]')
      .filter({ hasText: CLOSE_OR_STAY_TEXT_PATTERN })
      .first(),
  ];

  for (const candidate of candidates) {
    try {
      if (await candidate.isVisible()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function findRegionDialog(
  page: Page
): Promise<{ locator: Locator; text: string } | null> {
  for (const selector of REGION_CONTAINER_SELECTORS) {
    const locator = page.locator(selector).first();
    let visible = false;
    try {
      visible = await locator.isVisible();
    } catch {
      continue;
    }
    if (!visible) continue;

    let text = "";
    try {
      text = await locator.innerText();
    } catch {
      continue;
    }

    if (REGION_SIGNAL_PATTERN.test(text)) {
      return { locator, text };
    }
  }
  return null;
}

/**
 * Detects a country/region/currency ("shopping to X?") overlay and, only
 * when there is evidence the page is already on the UK store, dismisses it
 * without switching storefronts. Never clicks a "shop now" / "continue"
 * style action that would change the store. Reusable across competitors —
 * relies on accessible roles/text, not site-specific markup.
 */
export async function confirmUkRegion(page: Page): Promise<RegionResult> {
  // Give the overlay a brief moment to render after consent handling.
  await page.waitForTimeout(1000);

  const dialog = await findRegionDialog(page);
  if (!dialog) {
    return {
      regionStatus: "uk-confirmed",
      detectedStore: null,
      detectedCurrency: null,
    };
  }

  let bodyText = "";
  try {
    bodyText = await page.evaluate(() => document.body.innerText);
  } catch {
    bodyText = "";
  }
  const combinedText = `${dialog.text}\n${bodyText}`;

  const detectedStore = extractStore(combinedText);
  const detectedCurrency = extractCurrency(combinedText);
  const ukConfirmed =
    UK_CONFIRMATION_PATTERN.test(combinedText) ||
    (detectedStore !== null && /united kingdom/i.test(detectedStore));

  if (!ukConfirmed) {
    // A region-ish overlay exists but we can't reliably tell we're on the
    // UK store — don't guess, don't click anything.
    return { regionStatus: "could-not-confirm", detectedStore, detectedCurrency };
  }

  const closeControl = await findCloseOrStayControl(dialog.locator);
  if (!closeControl) {
    return { regionStatus: "could-not-confirm", detectedStore, detectedCurrency };
  }

  try {
    await closeControl.click({ timeout: 3000 });
    await dialog.locator.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  } catch {
    return { regionStatus: "could-not-confirm", detectedStore, detectedCurrency };
  }

  return {
    regionStatus: "uk-modal-dismissed",
    detectedStore,
    detectedCurrency,
  };
}
