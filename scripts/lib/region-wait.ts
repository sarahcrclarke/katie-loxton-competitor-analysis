import { pollUntil } from "./consent";

// Strathberry's region/shipping overlay has been observed appearing AFTER
// cookie consent is dismissed but before a single immediate check would
// see it — a timing/race condition, not a detection problem. This module
// only adds a bounded wait-and-recheck in front of the EXISTING,
// unmodified region detection/dismissal flow (confirmUkRegion in
// region.ts) — it contains no region-signal, UK-confirmation, or
// close-control logic of its own.
export const REGION_WAIT_MAX_MS = 10_000;
export const REGION_WAIT_POLL_INTERVAL_MS = 250;

export type RegionWaitDeps<T> = {
  // Cheap, side-effect-free check for "is a region signal visible right
  // now" — wire this to the existing, unmodified isRegionSignalVisible().
  checkSignal: () => Promise<boolean>;
  // The existing, unmodified full region handling flow (confirmUkRegion) —
  // called exactly once, after the wait, whether or not polling found
  // anything early. Preserves the prior always-called behaviour/return
  // shape exactly.
  handleRegion: () => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  // Overridable so tests can drive a deterministic fake clock instead of
  // depending on real wall-clock time.
  now?: () => number;
};

/**
 * Polls `checkSignal()` for up to `maxWaitMs` (default 10s, ~250ms
 * interval), starting immediately, so a region overlay that appears late
 * (after cookie consent but before the old one-shot check) still gets
 * caught. Stops as soon as a signal is seen — never waits out the full
 * bound if it appears earlier. Either way, `handleRegion()` — the
 * existing, unmodified confirmUkRegion() — is then called exactly once to
 * do the actual detection, UK confirmation, close-control strategies
 * (including the Strathberry top-right-icon fallback), and post-click
 * verification, unchanged.
 */
export async function waitForRegionThenHandle<T>(deps: RegionWaitDeps<T>): Promise<T> {
  const maxWaitMs = deps.maxWaitMs ?? REGION_WAIT_MAX_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? REGION_WAIT_POLL_INTERVAL_MS;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;

  log(`Region wait started: up to ${maxWaitMs}ms`);
  const startedAt = now();

  const detected = await pollUntil<true>(
    async () => ((await deps.checkSignal()) ? true : null),
    { maxWaitMs, pollIntervalMs, sleep: deps.sleep, now: deps.now }
  );

  if (detected) {
    log(`Region overlay detected after: ${now() - startedAt}ms`);
  } else {
    log(`Region wait completed: no overlay detected after ${maxWaitMs}ms`);
  }

  return deps.handleRegion();
}
