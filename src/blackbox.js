// The black box: an allocation-light breadcrumb ring buffer + JSON snapshot serialization.
// Pure — no platform refs — so it's unit-testable directly under `node --test` (no DI).

/** @typedef {import("./types.js").Breadcrumb} Breadcrumb */
/** @typedef {import("./types.js").Snapshot} Snapshot */

/**
 * Fixed-capacity breadcrumb ring buffer. Allocation-light hot path — pre-sized array, integer
 * head, overwrite-in-place, no push/shift. Drops oldest when full.
 */
export class RingBuffer {
  /** @param {number} capacity */
  constructor(capacity) {
    /** @type {(Breadcrumb | undefined)[]} */
    this.slots = new Array(Math.max(0, capacity));
    this.capacity = Math.max(0, capacity);
    /** Index of the next write — also the oldest entry once the buffer is full. */
    this.head = 0;
    this.size = 0;
  }

  /**
   * Record a crumb, overwriting the oldest in place once full. No allocation beyond
   * holding the reference; head advances modulo capacity.
   * @param {Breadcrumb} crumb
   * @returns {void}
   */
  push(crumb) {
    if (this.capacity === 0) {
      return;
    } // degenerate: nothing can be stored
    this.slots[this.head] = crumb;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    }
  }

  /**
   * Oldest→newest snapshot of the buffer.
   * @returns {Breadcrumb[]}
   */
  toArray() {
    // Not yet wrapped: entries sit in [0, size) already in insertion order.
    if (this.size < this.capacity) {
      return /** @type {Breadcrumb[]} */ (this.slots.slice(0, this.size));
    }
    // Full: the oldest entry is at head; read forward, wrapping at the end.
    return /** @type {Breadcrumb[]} */ ([
      ...this.slots.slice(this.head),
      ...this.slots.slice(0, this.head),
    ]);
  }
}

/** Reused encoder so serialize stays allocation-light on the hot path. */
const encoder = new TextEncoder();

/**
 * Serialize + size-cap a snapshot. JSON, since it's the only form localStorage can carry. Returns
 * the JSON string, or null if un-serializable (cycles throw) or over `maxBytes` — caller
 * breadcrumbs the rejection rather than throwing into the app.
 * @param {Snapshot} state
 * @param {number} maxBytes
 * @returns {string | null}
 */
export const serializeSnapshot = (state, maxBytes) => {
  let json;
  try {
    json = JSON.stringify(state);
  } catch {
    return null; // cycles, BigInt, throwing toJSON, …
  }
  // JSON.stringify yields undefined for a non-serializable root (undefined/function/symbol).
  if (typeof json !== "string") {
    return null;
  }
  if (encoder.encode(json).length > maxBytes) {
    return null;
  } // UTF-8 byte cap, not char count
  return json;
};

/**
 * Parse a persisted snapshot string (undefined if absent/invalid).
 * @param {string | null | undefined} json
 * @returns {Snapshot | undefined}
 */
export const parseSnapshot = (json) => {
  if (json == null || json === "") {
    return undefined;
  }
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};
