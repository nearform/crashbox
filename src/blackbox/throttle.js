// Coalescing throttle scheduler. Given a Clock and a flush fn, collapses bursts of
// requests into at-most-one flush per interval — keeps the durable write path cheap
// so the instrumentation never causes the OOM it's trying to catch (research §2).
// Pure (takes an injected Clock); Node-testable with a fake clock.

/**
 * @param {import("../ports/clock.js").Clock} _clock
 * @param {() => void} _flush
 * @param {number} _intervalMs
 * @returns {{ request: () => void, flushNow: () => void, stop: () => void }}
 */
export const createThrottle = (_clock, _flush, _intervalMs) => {
  throw new Error("not implemented"); // Phase 1
};
