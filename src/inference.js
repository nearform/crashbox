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

/**
 * @param {import("./types.js").LoadSignals} _signals
 * @returns {"crash" | "discard" | "clean" | "none"}
 */
export const classifyLoad = (_signals) => {
  throw new Error("not implemented"); // Phase 1
};

/**
 * @param {Object} input
 * @param {import("./types.js").Breadcrumb[]} input.breadcrumbs
 * @param {import("./types.js").LoadSignals} input.signals
 * @returns {import("./types.js").CrashReason}
 */
export const classifyReason = (input) => {
  void input;
  throw new Error("not implemented"); // Phase 1
};
