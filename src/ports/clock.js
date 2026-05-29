// Clock port — injected so the throttle/heartbeat logic is testable with a fake clock
// under `node --test` (no real timers).

/**
 * @typedef {Object} Clock
 * @property {() => number} now                                   Epoch ms.
 * @property {(fn: () => void, ms: number) => number} setInterval Returns a handle.
 * @property {(handle: number) => void} clearInterval
 */

export {};
