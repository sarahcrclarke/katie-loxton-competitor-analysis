import type { Page } from "playwright";

export type ConsentStatus = "rejected" | "not-present" | "could-not-dismiss";

// Matches accessible button text for a non-essential-cookie rejection
// control. Deliberately excludes any "accept"/"allow" wording — this must
// never be used to pick an accept action as a fallback.
const REJECT_TEXT_PATTERN =
  /reject all cookies|reject all|decline all|necessary cookies only|only necessary|continue without accepting|^reject$|^decline$/i;

// Cheap, vendor-agnostic signals that *some* consent UI is on the page,
// used only to distinguish "no banner at all" from "banner present but we
// couldn't find a reject control" when no reject button matched.
const BANNER_PRESENCE_SELECTORS = [
  '[role="dialog"]',
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
];

async function isElementVisible(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible();
  } catch {
    return false;
  }
}

async function isConsentBannerPresent(page: Page): Promise<boolean> {
  for (const selector of BANNER_PRESENCE_SELECTORS) {
    if (await isElementVisible(page, selector)) {
      return true;
    }
  }
  return false;
}

/**
 * Detects a cookie/privacy consent banner and, where a rejection control is
 * available, clicks it — never "accept". Reusable across competitors: it
 * relies only on generic accessible role/text matching, not any
 * site-specific markup.
 */
export async function dismissCookieConsent(page: Page): Promise<ConsentStatus> {
  // Give the banner a brief moment to render after navigation.
  await page.waitForTimeout(1000);

  const candidateRejectButtons = [
    page.getByRole("button", { name: REJECT_TEXT_PATTERN }).first(),
    page
      .locator('button, a[role="button"], [role="button"]')
      .filter({ hasText: REJECT_TEXT_PATTERN })
      .first(),
  ];

  for (const button of candidateRejectButtons) {
    try {
      await button.waitFor({ state: "visible", timeout: 4000 });
    } catch {
      continue;
    }

    try {
      await button.click({ timeout: 3000 });
      // Best-effort: wait for the banner to actually go away, but a
      // successful click on a genuine reject control still counts even if
      // it lingers slightly longer than this wait.
      await button.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
      return "rejected";
    } catch {
      continue;
    }
  }

  if (await isConsentBannerPresent(page)) {
    return "could-not-dismiss";
  }

  return "not-present";
}
