// IndexedDB adapter — the rich black-box store (breadcrumb tail + snapshot, keyed by
// sessionId). Async; survives tab crash. The ONLY src file importing `indexedDB`.
// Tested with fake-indexeddb under node --test (Phase 2-3).

/**
 * Partial Store backed by IndexedDB (the async rich half; combined with local-store via
 * composite-store).
 * @returns {Promise<Pick<import("../ports/store.js").Store, "put" | "get" | "previousSessionId" | "clear">>}
 */
export const createIdbStore = async () => {
  throw new Error("not implemented"); // Phase 3
};
