// Browser Clock adapter — real Date.now + window timers behind the Clock port.

/**
 * @returns {import("../ports/clock.js").Clock}
 */
export const createBrowserClock = () => {
  throw new Error("not implemented"); // Phase 3
};
