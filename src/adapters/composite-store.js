// Composite store — the full Store port. Writes through to both IndexedDB (rich, async)
// and localStorage (sync last-gasp); reads prefer IDB and fall back to the sync store.

/**
 * @param {Pick<import("../ports/store.js").Store, "put" | "get" | "previousSessionId" | "clear">} _idb
 * @param {Pick<import("../ports/store.js").Store, "syncSet" | "syncGet">} _local
 * @returns {import("../ports/store.js").Store}
 */
export const createCompositeStore = (_idb, _local) => {
  throw new Error("not implemented"); // Phase 3
};
