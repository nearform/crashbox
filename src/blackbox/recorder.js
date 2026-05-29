// Recorder — the hot-path facade. Owns the ring buffer + current snapshot and flushes
// through the Store port on a throttled cadence. `breadcrumb()` must be allocation-light
// (research §2): append to the ring + sync last-gasp write only; the rich IDB flush is
// coalesced via the throttle.

/**
 * @param {Object} deps
 * @param {import("../ports/store.js").Store} deps.store
 * @param {import("../ports/clock.js").Clock} deps.clock
 * @param {string} deps.sessionId
 * @param {import("../types.js").ResolvedOptions} deps.options
 * @returns {Recorder}
 */
export const createRecorder = (deps) => {
  void deps;
  throw new Error("not implemented"); // Phase 2
};

/**
 * @typedef {Object} Recorder
 * @property {(msg: string, data?: Record<string, unknown>) => void} breadcrumb
 * @property {(state: import("../types.js").Snapshot) => void} setSnapshot
 * @property {() => void} flush
 * @property {() => void} stop
 */
