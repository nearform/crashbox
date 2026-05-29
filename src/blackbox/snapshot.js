// Snapshot serialization + size cap. Research §8 #7: standardize on JSON (the
// localStorage fallback can only carry strings anyway, and JSON is ~5x faster than
// structuredClone and sub-50µs at KB scale). Enforce a byte cap; reject un-serializable
// input (cycles throw, functions/Maps/typed-arrays are lossy) without throwing into the app.

/**
 * Serialize + size-cap an app snapshot. Returns the JSON string, or null if it is
 * un-serializable or exceeds `maxBytes` (caller breadcrumbs the rejection).
 * @param {import("../types.js").Snapshot} _state
 * @param {number} _maxBytes
 * @returns {string | null}
 */
export const serializeSnapshot = (_state, _maxBytes) => {
  throw new Error("not implemented"); // Phase 1
};

/**
 * Parse a persisted snapshot string back into an object (undefined if absent/invalid).
 * @param {string | null | undefined} _json
 * @returns {import("../types.js").Snapshot | undefined}
 */
export const parseSnapshot = (_json) => {
  throw new Error("not implemented"); // Phase 1
};
