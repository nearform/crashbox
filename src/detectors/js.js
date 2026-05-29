// JS/general detector — default-on. `onerror`, `onunhandledrejection`, and long-task
// detection. Research §6 caveat: iOS Safari does NOT support PerformanceObserver
// 'longtask', so hang detection uses a main-thread watchdog (setInterval drift), not
// PerformanceObserver, on the primary target.

/**
 * @param {import("./registry.js").DetectorContext} _ctx
 * @returns {import("./registry.js").Detector}
 */
export const createJsDetector = (_ctx) => {
  throw new Error("not implemented"); // Phase 3
};
