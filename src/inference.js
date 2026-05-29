// Crash inference — pure functions, the heart of the SDK. Directly unit-testable under
// `node --test` (take plain data, no DI). Two steps run on the next load:
//
//   classifyLoad(signals)  — discard-vs-crash guard (research §8 #2, iOS 18.7):
//     1. wasDiscarded === true       → "discard" (suppress; a real crash never sets this)
//     2. cleanShutdown marker present → "clean"  (graceful exit)
//     3. live session, neither above  → "crash"
//     (Do NOT use navigationType or a short heartbeatAge — a crash reloads as "navigate"
//      with a sub-second gap, indistinguishable from a fresh load.)
//
//   classifyReason(breadcrumbs, signals) — only when classifyLoad === "crash":
//     device.lost/GPUOutOfMemoryError in tail → "webgpu-device-lost"
//     WASM RangeError / memory-near-cap       → "oom"
//     nothing but a stale heartbeat           → "hard-kill"
//     else                                    → "unknown"
//   (Both GPU and WASM OOM hard-kill the tab with no live event — research §8 #1/#4 — so the
//    reason comes from the breadcrumb tail, not a death event.)

/** @typedef {import("./types.js").Breadcrumb} Breadcrumb */
/** @typedef {import("./types.js").CrashReason} CrashReason */

/**
 * Discard-vs-crash guard. Precedence (research §8 #2, iOS 18.7):
 *   0. no prior black box (`!hasLiveSession`) → "none"   (nothing to classify)
 *   1. `wasDiscarded === true`                → "discard" (iOS discard never set by a crash)
 *   2. `cleanShutdown` marker present         → "clean"   (graceful exit wrote the marker)
 *   3. a live session, neither above          → "crash"
 * Deliberately ignores `navigationType`/`heartbeatAgeMs`: a crash reloads as "navigate" with a
 * sub-second gap, indistinguishable from a fresh load — they'd cry wolf.
 * @param {import("./types.js").LoadSignals} signals
 * @returns {"crash" | "discard" | "clean" | "none"}
 */
export const classifyLoad = (signals) => {
  if (!signals || !signals.hasLiveSession) {
    return "none";
  }
  if (signals.wasDiscarded === true) {
    return "discard";
  }
  if (signals.cleanShutdown === true) {
    return "clean";
  }
  return "crash";
};

/**
 * Breadcrumb-tail markers each crash reason keys off. Matched against a crumb's `msg`
 * (case-insensitive substring) or an explicit `data.signal` token, so detectors (Phase 3/5/6)
 * can flag a reason either way. Exported as the shared contract between detectors and inference.
 * @type {Record<"webgpu-device-lost" | "oom", string[]>}
 */
export const REASON_SIGNALS = {
  "webgpu-device-lost": [
    "device.lost",
    "device-lost",
    "gpuoutofmemoryerror",
    "webgpu-device-lost",
  ],
  oom: ["rangeerror", "out of memory", "memory-near-cap", "wasm-oom", "oom"],
};

/**
 * Does a breadcrumb carry one of `markers`?
 * @param {Breadcrumb} crumb
 * @param {string[]} markers
 * @returns {boolean}
 */
const crumbMatches = (crumb, markers) => {
  const msg = typeof crumb.msg === "string" ? crumb.msg.toLowerCase() : "";
  if (markers.some((m) => msg.includes(m))) {
    return true;
  }
  const signal = crumb.data && crumb.data.signal;
  return typeof signal === "string" && markers.includes(signal.toLowerCase());
};

/**
 * Infer *why* the previous session crashed — only meaningful when `classifyLoad === "crash"`.
 * Both GPU and WASM OOM hard-kill the tab with no live event (research §8 #1/#4), so the cause
 * comes from the breadcrumb tail, not a death event. Precedence:
 *   1. WebGPU device-loss / GPUOutOfMemoryError marker → "webgpu-device-lost"
 *   2. WASM RangeError / memory-near-cap marker         → "oom"
 *   3. no cause marker but a heartbeat trail exists      → "hard-kill" (knew it died, not why)
 *   4. nothing to go on                                  → "unknown"
 * @param {Object} input
 * @param {Breadcrumb[]} input.breadcrumbs
 * @param {import("./types.js").LoadSignals} input.signals
 * @returns {CrashReason}
 */
export const classifyReason = (input) => {
  const tail = input.breadcrumbs || [];
  if (tail.some((c) => crumbMatches(c, REASON_SIGNALS["webgpu-device-lost"]))) {
    return "webgpu-device-lost";
  }
  if (tail.some((c) => crumbMatches(c, REASON_SIGNALS.oom))) {
    return "oom";
  }
  // A recorded heartbeat means we saw it alive then it vanished: a hard kill we can't attribute.
  if (input.signals && input.signals.heartbeatAgeMs != null) {
    return "hard-kill";
  }
  return "unknown";
};
