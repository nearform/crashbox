// Crash-reason classification (pure). Given the breadcrumb tail + load signals, infer
// the CrashReason. Reason precedence (SPEC §0 open item, resolved here):
//   device.lost / GPUOutOfMemoryError in tail → "webgpu-device-lost"
//   memory-near-cap / WASM RangeError / OOM   → "oom"
//   live session, no clean marker, no clue    → "hard-kill"
//   otherwise                                 → "unknown"
// Both GPU and WASM OOM hard-kill the tab with no live event (research §8 #1/#4), so the
// reason is recovered from the breadcrumb tail, not a death event.

/**
 * @param {Object} input
 * @param {import("../types.js").Breadcrumb[]} input.breadcrumbs
 * @param {import("../types.js").LoadSignals} input.signals
 * @returns {import("../types.js").CrashReason}
 */
export const classifyReason = (input) => {
  void input;
  throw new Error("not implemented"); // Phase 1
};
