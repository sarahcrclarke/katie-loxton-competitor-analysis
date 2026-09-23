/**
 * Deterministic regression tests for the region-overlay bounded wait
 * (scripts/lib/region-wait.ts), added to fix a live timing/race condition:
 * Strathberry's region overlay was sometimes observed appearing AFTER the
 * old one-shot region check but BEFORE the screenshot.
 *
 * These tests drive waitForRegionThenHandle() with a fully fake, injectable
 * clock and sleep — no real timers, no Playwright — so they run instantly
 * regardless of the 10s bound being exercised.
 *
 * Run with: npx tsx scripts/lib/region-wait.test.ts
 */
import assert from "node:assert/strict";
import {
  waitForRegionThenHandle,
  REGION_WAIT_MAX_MS,
  REGION_WAIT_POLL_INTERVAL_MS,
} from "./region-wait";

function makeFakeClock() {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    sleeps,
  };
}

async function run() {
  console.log("Running region-wait.ts regression tests...");

  // A. Region modal already present: detected immediately, no waiting.
  {
    const { now, sleep, sleeps } = makeFakeClock();
    let checkSignalCalls = 0;
    const logs: string[] = [];
    let handleRegionCalls = 0;

    const result = await waitForRegionThenHandle({
      checkSignal: async () => {
        checkSignalCalls++;
        return true;
      },
      handleRegion: async () => {
        handleRegionCalls++;
        return "handled";
      },
      sleep,
      now,
      log: (m) => logs.push(m),
    });

    assert.equal(result, "handled");
    assert.equal(checkSignalCalls, 1, "A: must detect on the very first check");
    assert.equal(sleeps.length, 0, "A: must not sleep at all when already present");
    assert.equal(handleRegionCalls, 1, "A: existing region handler must still run exactly once");
    assert.ok(
      logs.some((l) => l === `Region wait started: up to ${REGION_WAIT_MAX_MS}ms`),
      "A: expected the wait-started log line"
    );
    assert.ok(
      logs.some((l) => l === "Region overlay detected after: 0ms"),
      "A: expected an immediate detection log line"
    );
    assert.ok(
      !logs.some((l) => l.startsWith("Region wait completed: no overlay")),
      "A: must not log a timeout when detected immediately"
    );
    console.log("  ok: A — already present, detected immediately, no sleep");
  }

  // B. Region modal appears after ~2 seconds: polling detects it, existing
  //    handler runs.
  {
    const { now, sleep, sleeps } = makeFakeClock();
    let checkSignalCalls = 0;
    let handleRegionCalls = 0;
    const logs: string[] = [];

    const result = await waitForRegionThenHandle({
      checkSignal: async () => {
        checkSignalCalls++;
        return now() >= 2000;
      },
      handleRegion: async () => {
        handleRegionCalls++;
        return "handled";
      },
      sleep,
      now,
      log: (m) => logs.push(m),
    });

    assert.equal(result, "handled");
    assert.equal(handleRegionCalls, 1);
    // First check at t=0 (false), then polls every 250ms until t=2000.
    assert.equal(sleeps.length, 2000 / REGION_WAIT_POLL_INTERVAL_MS, "B: expected polling at the ~250ms interval");
    assert.ok(sleeps.every((s) => s === REGION_WAIT_POLL_INTERVAL_MS));
    assert.ok(checkSignalCalls > 1, "B: must have polled more than once");
    assert.ok(
      logs.some((l) => l === "Region overlay detected after: 2000ms"),
      "B: expected detection logged at ~2000ms"
    );
    console.log("  ok: B — appears after ~2s, polling catches it before handling");
  }

  // C. Region modal appears after ~8 seconds: still detected and handled
  //    (within the 10s bound) before the caller would take a screenshot.
  {
    const { now, sleep, sleeps } = makeFakeClock();
    let handleRegionCalls = 0;
    const logs: string[] = [];

    const result = await waitForRegionThenHandle({
      checkSignal: async () => now() >= 8000,
      handleRegion: async () => {
        handleRegionCalls++;
        return "handled";
      },
      sleep,
      now,
      log: (m) => logs.push(m),
    });

    assert.equal(result, "handled");
    assert.equal(handleRegionCalls, 1);
    assert.equal(now(), 8000, "C: must stop polling as soon as it's detected, not run to 10000ms");
    assert.ok(sleeps.length < REGION_WAIT_MAX_MS / REGION_WAIT_POLL_INTERVAL_MS);
    assert.ok(logs.some((l) => l === "Region overlay detected after: 8000ms"));
    console.log("  ok: C — appears after ~8s, still detected and handled before the bound");
  }

  // D. Region modal never appears: polling stops at the 10s bound, capture
  //    continues (handleRegion still runs, exactly as it always has), no
  //    infinite loop.
  {
    const { now, sleep, sleeps } = makeFakeClock();
    let checkSignalCalls = 0;
    let handleRegionCalls = 0;
    const logs: string[] = [];

    const result = await waitForRegionThenHandle({
      checkSignal: async () => {
        checkSignalCalls++;
        return false;
      },
      handleRegion: async () => {
        handleRegionCalls++;
        return "handled-anyway";
      },
      sleep,
      now,
      log: (m) => logs.push(m),
    });

    assert.equal(result, "handled-anyway", "D: the existing handler must still run once even with no overlay");
    assert.equal(handleRegionCalls, 1);
    assert.equal(now(), REGION_WAIT_MAX_MS, "D: must stop exactly at the 10s bound, not run forever");
    assert.equal(
      checkSignalCalls,
      REGION_WAIT_MAX_MS / REGION_WAIT_POLL_INTERVAL_MS + 1,
      "D: expected one check per interval plus the initial immediate check"
    );
    assert.ok(
      logs.some((l) => l === `Region wait completed: no overlay detected after ${REGION_WAIT_MAX_MS}ms`),
      "D: expected the timeout log line"
    );
    console.log("  ok: D — never appears, polling stops at the 10s bound, no infinite loop");
  }

  // E. Cookie dismissal completes first: region polling must begin AFTER
  //    consent handling, not concurrently with it. Mirrors the exact
  //    sequential composition used in capture-strathberry.ts.
  {
    const order: string[] = [];
    const { now, sleep } = makeFakeClock();

    async function fakeDismissCookieConsent(): Promise<string> {
      order.push("consent-start");
      // Simulate consent handling doing real async work before resolving.
      await Promise.resolve();
      order.push("consent-done");
      return "rejected";
    }

    async function runCaptureSequence() {
      const consentStatus = await fakeDismissCookieConsent();
      const regionStatus = await waitForRegionThenHandle({
        checkSignal: async () => {
          order.push("region-poll-checkSignal");
          return true;
        },
        handleRegion: async () => {
          order.push("region-handled");
          return "uk-modal-dismissed";
        },
        sleep,
        now,
      });
      return { consentStatus, regionStatus };
    }

    const { consentStatus, regionStatus } = await runCaptureSequence();

    assert.equal(consentStatus, "rejected");
    assert.equal(regionStatus, "uk-modal-dismissed");
    assert.deepEqual(
      order,
      ["consent-start", "consent-done", "region-poll-checkSignal", "region-handled"],
      "E: region polling must not start until consent handling has fully completed"
    );
    console.log("  ok: E — region polling begins only after consent handling has completed");
  }

  console.log("All region-wait.ts regression tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
