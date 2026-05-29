// Fixed-capacity breadcrumb ring buffer. Allocation-light by design (research §2): a
// pre-sized array with an integer head, overwritten in place — no push/shift growth.
// Drops the oldest entry when full. Pure; no platform refs (Node-testable).

export class RingBuffer {
  /** @param {number} capacity */
  constructor(capacity) {
    /** @type {(import("../types.js").Breadcrumb | undefined)[]} */
    this.slots = new Array(capacity);
    /** @type {number} */
    this.capacity = capacity;
    /** @type {number} index of the next write */
    this.head = 0;
    /** @type {number} current count (<= capacity) */
    this.size = 0;
  }

  /**
   * Append a breadcrumb, overwriting the oldest if full.
   * @param {import("../types.js").Breadcrumb} _crumb
   * @returns {void}
   */
  push(_crumb) {
    throw new Error("not implemented"); // Phase 1
  }

  /**
   * Snapshot the buffer oldest→newest.
   * @returns {import("../types.js").Breadcrumb[]}
   */
  toArray() {
    throw new Error("not implemented"); // Phase 1
  }

  /** @returns {void} */
  clear() {
    throw new Error("not implemented"); // Phase 1
  }
}
