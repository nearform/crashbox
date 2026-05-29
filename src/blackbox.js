// The black box: an allocation-light breadcrumb ring buffer + JSON snapshot serialization.
// Pure — no platform refs — so it's unit-testable directly under `node --test` (no DI).

/**
 * Fixed-capacity breadcrumb ring buffer (research §2: allocation-light hot path — pre-sized
 * array, integer head, overwrite-in-place, no push/shift). Drops oldest when full.
 */
export class RingBuffer {
  /** @param {number} capacity */
  constructor(capacity) {
    /** @type {(import("./types.js").Breadcrumb | undefined)[]} */
    this.slots = new Array(capacity);
    this.capacity = capacity;
    this.head = 0;
    this.size = 0;
  }

  /**
   * @param {import("./types.js").Breadcrumb} _crumb
   * @returns {void}
   */
  push(_crumb) {
    throw new Error("not implemented"); // Phase 1
  }

  /**
   * Oldest→newest snapshot of the buffer.
   * @returns {import("./types.js").Breadcrumb[]}
   */
  toArray() {
    throw new Error("not implemented"); // Phase 1
  }
}

/**
 * Serialize + size-cap a snapshot. JSON (research §8 #7: ~5x faster than structuredClone,
 * sub-50µs at KB scale, and the only thing the localStorage fallback can carry). Returns the
 * JSON string, or null if un-serializable (cycles throw) or over `maxBytes` — caller
 * breadcrumbs the rejection rather than throwing into the app.
 * @param {import("./types.js").Snapshot} _state
 * @param {number} _maxBytes
 * @returns {string | null}
 */
export const serializeSnapshot = (_state, _maxBytes) => {
  throw new Error("not implemented"); // Phase 1
};

/**
 * Parse a persisted snapshot string (undefined if absent/invalid).
 * @param {string | null | undefined} _json
 * @returns {import("./types.js").Snapshot | undefined}
 */
export const parseSnapshot = (_json) => {
  throw new Error("not implemented"); // Phase 1
};
