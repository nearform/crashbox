// Discard-vs-crash disambiguation (pure) — the iOS false-positive guard (research §8 #2,
// the highest-risk correctness item). Verdict from LoadSignals, validated on iOS 18.7:
//
//   1. wasDiscarded === true            → DISCARD (suppress). A real crash never sets this.
//   2. cleanShutdown marker present     → CLEAN EXIT (no crash).
//   3. live session, no marker, !discard → CRASH.
//
// Do NOT use navigationType or a short heartbeatAge to gate the decision (a crash reloads
// as "navigate" with a sub-second heartbeat gap, indistinguishable from a fresh load).

/**
 * @param {import("../types.js").LoadSignals} _signals
 * @returns {"crash" | "discard" | "clean" | "none"}
 */
export const classifyLoad = (_signals) => {
  throw new Error("not implemented"); // Phase 1
};
