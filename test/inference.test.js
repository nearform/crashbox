import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLoad,
  classifyReason,
  REASON_SIGNALS,
} from "../src/inference.js";

// Crash inference — the load truth table (discard-vs-crash guard) and the
// reason precedence from the breadcrumb tail. Plain data in/out, no browser.

/**
 * @param {Partial<import("../src/types.js").LoadSignals>} [over]
 * @returns {import("../src/types.js").LoadSignals}
 */
const signals = (over = {}) => ({
  wasDiscarded: false,
  cleanShutdown: false,
  heartbeatAgeMs: null,
  hasLiveSession: true,
  ...over,
});

/**
 * @param {string} msg
 * @param {Record<string, unknown>} [data]
 * @returns {import("../src/types.js").Breadcrumb}
 */
const crumb = (msg, data) => ({ t: 0, msg, ...(data ? { data } : {}) });

// --- classifyLoad ---------------------------------------------------------

test("classifyLoad: no prior session → none", () => {
  assert.equal(classifyLoad(signals({ hasLiveSession: false })), "none");
});

test("classifyLoad: no prior session wins even over other signals", () => {
  assert.equal(
    classifyLoad(
      signals({
        hasLiveSession: false,
        wasDiscarded: true,
        cleanShutdown: true,
      }),
    ),
    "none",
  );
});

test("classifyLoad: wasDiscarded → discard (suppresses crash)", () => {
  assert.equal(classifyLoad(signals({ wasDiscarded: true })), "discard");
});

test("classifyLoad: discard takes precedence over a clean marker", () => {
  assert.equal(
    classifyLoad(signals({ wasDiscarded: true, cleanShutdown: true })),
    "discard",
  );
});

test("classifyLoad: cleanShutdown marker → clean", () => {
  assert.equal(classifyLoad(signals({ cleanShutdown: true })), "clean");
});

test("classifyLoad: live session, no discard, no clean marker → crash", () => {
  assert.equal(classifyLoad(signals()), "crash");
});

test("classifyLoad: a sub-second heartbeat gap does NOT mask a crash", () => {
  // navigationType / heartbeatAge are deliberately ignored by the guard.
  assert.equal(
    classifyLoad(signals({ heartbeatAgeMs: 200, navigationType: "navigate" })),
    "crash",
  );
});

test("classifyLoad: missing signals object → none (defensive)", () => {
  // @ts-expect-error exercising the defensive guard
  assert.equal(classifyLoad(undefined), "none");
});

// --- classifyReason -------------------------------------------------------

test("classifyReason: device.lost in the tail → webgpu-device-lost", () => {
  const reason = classifyReason({
    breadcrumbs: [crumb("heartbeat"), crumb("device.lost: destroyed")],
    signals: signals({ heartbeatAgeMs: 5000 }),
  });
  assert.equal(reason, "webgpu-device-lost");
});

test("classifyReason: GPUOutOfMemoryError → webgpu-device-lost", () => {
  const reason = classifyReason({
    breadcrumbs: [crumb("uncaught GPUOutOfMemoryError")],
    signals: signals(),
  });
  assert.equal(reason, "webgpu-device-lost");
});

test("classifyReason: WASM RangeError → oom", () => {
  const reason = classifyReason({
    breadcrumbs: [crumb("RangeError: WebAssembly.Memory.grow failed")],
    signals: signals({ heartbeatAgeMs: 3000 }),
  });
  assert.equal(reason, "oom");
});

test("classifyReason: data.signal token matches even without msg text", () => {
  const reason = classifyReason({
    breadcrumbs: [crumb("memory growth", { signal: "memory-near-cap" })],
    signals: signals(),
  });
  assert.equal(reason, "oom");
});

test("classifyReason: webgpu wins over oom when both present (precedence)", () => {
  const reason = classifyReason({
    breadcrumbs: [crumb("RangeError"), crumb("device.lost")],
    signals: signals(),
  });
  assert.equal(reason, "webgpu-device-lost");
});

test("classifyReason: heartbeat trail but no cause marker → hard-kill", () => {
  const reason = classifyReason({
    breadcrumbs: [crumb("heartbeat"), crumb("rendering frame")],
    signals: signals({ heartbeatAgeMs: 8000 }),
  });
  assert.equal(reason, "hard-kill");
});

test("classifyReason: nothing to go on → unknown", () => {
  const reason = classifyReason({
    breadcrumbs: [],
    signals: signals({ heartbeatAgeMs: null }),
  });
  assert.equal(reason, "unknown");
});

test("classifyReason: empty breadcrumbs but a heartbeat → hard-kill", () => {
  const reason = classifyReason({
    breadcrumbs: [],
    signals: signals({ heartbeatAgeMs: 4000 }),
  });
  assert.equal(reason, "hard-kill");
});

test("classifyReason: matching is case-insensitive", () => {
  const reason = classifyReason({
    breadcrumbs: [crumb("DEVICE.LOST")],
    signals: signals(),
  });
  assert.equal(reason, "webgpu-device-lost");
});

test("REASON_SIGNALS: exposes the marker contract for detectors", () => {
  assert.ok(Array.isArray(REASON_SIGNALS["webgpu-device-lost"]));
  assert.ok(REASON_SIGNALS.oom.length > 0);
});
