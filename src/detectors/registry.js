// Detector registry — maps option names to detector factories and enables the selected
// set. A detector observes its source and drops breadcrumbs / fires early-warning
// callbacks; it does NOT catch the kill itself (hard kills have no live event — that's
// Layer-3 inference).

/**
 * @typedef {Object} Detector
 * @property {() => void} stop  Tear down listeners.
 */

/**
 * @typedef {Object} DetectorContext
 * @property {(msg: string, data?: Record<string, unknown>) => void} breadcrumb
 * @property {import("../types.js").ResolvedOptions} options
 */

/**
 * Enable the detectors named in options.detectors.
 * @param {DetectorContext} _ctx
 * @returns {Detector[]}
 */
export const enableDetectors = (_ctx) => {
  throw new Error("not implemented"); // Phase 3+
};
