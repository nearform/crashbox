// Heartbeat — writes a `lastSeen` timestamp synchronously every `heartbeatMs` (default
// ~2s) so the next load can estimate time-of-death. Research §8 #2 caveat: a short
// heartbeat age does NOT rule out a crash (iOS auto-reloads fast), so this feeds
// time-of-death estimation, not the crash decision itself.

/**
 * @param {Object} deps
 * @param {import("./ports/store.js").Store} deps.store
 * @param {import("./ports/clock.js").Clock} deps.clock
 * @param {string} deps.sessionId
 * @param {number} deps.heartbeatMs
 * @returns {{ start: () => void, stop: () => void }}
 */
export const createHeartbeat = (deps) => {
  void deps;
  throw new Error("not implemented"); // Phase 2
};
