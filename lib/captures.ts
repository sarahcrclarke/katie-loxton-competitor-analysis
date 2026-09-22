import fs from "node:fs/promises";
import path from "node:path";

export type CaptureRecord = {
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
  screenshotPath: string;
  success: boolean;
  error: string | null;
};

const CAPTURES_ROOT = path.join(process.cwd(), "public", "captures");

/**
 * Returns the most recent successful capture record for a competitor, or
 * null if none exists yet. Never fabricates a result — a missing or
 * unreadable capture directory simply yields null.
 */
export async function getLatestSuccessfulCapture(
  competitor: string
): Promise<CaptureRecord | null> {
  const competitorDir = path.join(CAPTURES_ROOT, competitor);

  let dateDirs: string[];
  try {
    dateDirs = (await fs.readdir(competitorDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }

  for (const dateDir of dateDirs) {
    const recordPath = path.join(
      competitorDir,
      dateDir,
      "mobile-homepage.json"
    );
    try {
      const raw = await fs.readFile(recordPath, "utf-8");
      const record = JSON.parse(raw) as CaptureRecord;
      if (record.success) {
        return record;
      }
    } catch {
      // No record for this date, or it failed to parse — skip it.
      continue;
    }
  }

  return null;
}
