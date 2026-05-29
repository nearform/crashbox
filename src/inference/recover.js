// Recovery orchestration — runs once on the next load. Loads the previous session from
// the Store, runs classifyLoad (discard guard) then classifyReason, builds the
// CrashRecord, optionally corroborates via the Reporting API, and clears the recovered
// session (retention). Returns null when there was no crash (clean exit / discard / none).

/**
 * @param {Object} deps
 * @param {import("../ports/store.js").Store} deps.store
 * @param {import("../ports/lifecycle.js").Lifecycle} deps.lifecycle
 * @returns {Promise<import("../types.js").CrashRecord | null>}
 */
export const recover = async (deps) => {
  void deps;
  throw new Error("not implemented"); // Phase 2
};
