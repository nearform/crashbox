// Browser Lifecycle adapter — the ONLY src file importing window/document. Research §8 #2
// (iOS 18.7): write the clean-shutdown marker ONLY on `pagehide` with `persisted === false`
// (never on visibilitychange:hidden or pagehide{persisted:true}). readLoadSignals captures
// document.wasDiscarded, navigation type, and the prior heartbeat age.

/**
 * @param {Object} deps
 * @param {import("../ports/store.js").Store} deps.store
 * @param {string} deps.sessionId
 * @returns {import("../ports/lifecycle.js").Lifecycle}
 */
export const createBrowserLifecycle = (deps) => {
  void deps;
  throw new Error("not implemented"); // Phase 3
};
