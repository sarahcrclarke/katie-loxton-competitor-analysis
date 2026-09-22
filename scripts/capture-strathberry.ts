import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const COMPETITOR = "strathberry";
const TARGET_URL = "https://www.strathberry.com/";

const VIEWPORT = {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  isMobile: true,
  label: "390x844 mobile (iPhone-class CSS viewport, 1x)",
};

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// WebP's format ceiling is 16383px per dimension. Segments are kept well
// under that so any one image also stays a reasonable file size.
const MAX_SEGMENT_HEIGHT = 8000;

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
  screenshotPaths: string[];
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

/**
 * Encodes a full-page PNG buffer to WebP. When the page is too tall for a
 * single WebP image, it is sliced into sequential top-to-bottom segments
 * instead of being cropped — the full homepage is always preserved.
 */
async function writeWebpSegments(
  pngBuffer: Buffer,
  outputDir: string,
  baseFileName: string,
  baseRelativeDir: string
): Promise<string[]> {
  const image = sharp(pngBuffer);
  const metadata = await image.metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) {
    throw new Error("Could not read screenshot dimensions");
  }

  if (height <= MAX_SEGMENT_HEIGHT) {
    const fileName = `${baseFileName}.webp`;
    await image.webp({ quality: 80 }).toFile(path.join(outputDir, fileName));
    return [path.posix.join(baseRelativeDir, fileName)];
  }

  const segmentCount = Math.ceil(height / MAX_SEGMENT_HEIGHT);
  const relativePaths: string[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const top = i * MAX_SEGMENT_HEIGHT;
    const segmentHeight = Math.min(MAX_SEGMENT_HEIGHT, height - top);
    const fileName = `${baseFileName}-part-${i + 1}.webp`;
    await sharp(pngBuffer)
      .extract({ left: 0, top, width, height: segmentHeight })
      .webp({ quality: 80 })
      .toFile(path.join(outputDir, fileName));
    relativePaths.push(path.posix.join(baseRelativeDir, fileName));
  }
  return relativePaths;
}

async function main() {
  const dateDir = todayUtcDateString();
  const baseRelativeDir = path.posix.join(
    "public",
    "captures",
    COMPETITOR,
    dateDir
  );
  const outputDir = path.join(process.cwd(), baseRelativeDir);
  const recordAbsolutePath = path.join(outputDir, "mobile-homepage.json");

  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString();
  let record: CaptureRecord = {
    competitor: COMPETITOR,
    url: TARGET_URL,
    timestamp,
    viewport: VIEWPORT,
    screenshotPaths: [],
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
    const screenshotPaths = await writeWebpSegments(
      pngBuffer,
      outputDir,
      "mobile-homepage",
      baseRelativeDir
    );

    record = {
      ...record,
      screenshotPaths,
      success: true,
      error: null,
    };
    console.log(
      `Captured ${COMPETITOR} homepage -> ${screenshotPaths.join(", ")}`
    );
  } catch (err) {
    record = {
      ...record,
      screenshotPaths: [],
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
