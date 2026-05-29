// localStorage adapter — the synchronous last-gasp store (heartbeat + most-recent crumb +
// clean-shutdown marker). The ONLY src file importing `localStorage`. Research §8 #1
// confirmed sync writes survive a real iOS OOM kill, so this is the trustworthy fallback.

/**
 * The synchronous half of the Store.
 * @returns {Pick<import("../ports/store.js").Store, "syncSet" | "syncGet">}
 */
export const createLocalStore = () => {
  throw new Error("not implemented"); // Phase 3
};
