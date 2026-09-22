import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const COMPETITOR = "strathberry";
const TARGET_URL = "https://www.strathberry.com/";

const VIEWPORT = {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  isMobile: true,
  label: "390x844 mobile (iPhone 12/13-class)",
};

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

type CaptureRecord = {
  competitor: string;
  url: string;
  timestamp: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
    label: string;
  };
  screenshotPath: string | null;
  success: boolean;
  error: string | null;
};

function todayUtcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

async function scrollThroughPage(page: import("playwright").Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const scrollStep = 400;
      let scrolled = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, scrollStep);
        scrolled += scrollStep;
        if (scrolled >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 250);
    });
  });
  // Let the final batch of lazy-loaded images settle, then return to the
  // top so the full-page screenshot starts from a consistent position.
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
}

async function main() {
  const dateDir = todayUtcDateString();
  const outputDir = path.join(
    process.cwd(),
    "public",
    "captures",
    COMPETITOR,
    dateDir
  );
  const screenshotRelativePath = path.posix.join(
    "public",
    "captures",
    COMPETITOR,
    dateDir,
    "mobile-homepage.webp"
  );
  const screenshotAbsolutePath = path.join(
    outputDir,
    "mobile-homepage.webp"
  );
  const recordAbsolutePath = path.join(outputDir, "mobile-homepage.json");

  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString();
  let record: CaptureRecord = {
    competitor: COMPETITOR,
    url: TARGET_URL,
    timestamp,
    viewport: VIEWPORT,
    screenshotPath: null,
    success: false,
    error: null,
  };

  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      deviceScaleFactor: VIEWPORT.deviceScaleFactor,
      isMobile: VIEWPORT.isMobile,
      hasTouch: true,
      userAgent: USER_AGENT,
      locale: "en-GB",
      timezoneId: "Europe/London",
    });
    const page = await context.newPage();

    await page.goto(TARGET_URL, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });

    await scrollThroughPage(page);

    const pngBuffer = await page.screenshot({ fullPage: true });
    await sharp(pngBuffer).webp({ quality: 80 }).toFile(screenshotAbsolutePath);

    record = {
      ...record,
      screenshotPath: screenshotRelativePath,
      success: true,
      error: null,
    };
    console.log(`Captured ${COMPETITOR} homepage -> ${screenshotRelativePath}`);
  } catch (err) {
    record = {
      ...record,
      screenshotPath: null,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
    console.error(`Capture failed for ${COMPETITOR}:`, record.error);
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  await fs.writeFile(recordAbsolutePath, JSON.stringify(record, null, 2) + "\n");

  if (!record.success) {
    process.exitCode = 1;
  }
}

main();
