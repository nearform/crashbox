// Opt-in `window.__crashbox` debug handle (attached only when `init({ debug: true })`). Kept out of
// the spine because it's pure developer-convenience and the only place crashbox touches the global
// namespace. It receives its dependencies (the public API + live getters for the key prefix and the
// recovered record) from index.js, mirroring how detectors receive their context — so this module
// holds no crashbox state of its own.

import { getStorage, getWindow } from "./env.js";

/**
 * @typedef {Object} DebugContext
 * @property {Record<string, unknown>} api The public API functions to expose on the handle.
 * @property {() => string} getKeyPrefix Current localStorage key prefix (namespace-dependent).
 * @property {() => import("./types.js").CrashRecord | null} getRecovered The crash recovered this load.
 */

/**
 * Every `crashbox:*` key currently in localStorage, for the given prefix.
 * @param {string} keyPrefix
 * @returns {string[]}
 */
const debugKeys = (keyPrefix) => {
  const storage = getStorage();
  /** @type {string[]} */
  const out = [];
  if (storage) {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(`${keyPrefix}:`)) {
        out.push(k);
      }
    }
  }
  return out;
};

/**
 * Attach a `window.__crashbox` console handle: the public API plus storage introspection
 * (`dump`/`clear`) and `recovered()`. Only called when `options.debug` is set, and only where a
 * window exists — the SDK otherwise never touches the global namespace.
 * @param {DebugContext} ctx
 */
export const attachDebugHandle = (ctx) => {
  const win = getWindow();
  if (!win) {
    return;
  }
  // GLOBAL AUGMENTATION (not a method wrap): add a `__crashbox` property to the global `window`.
  // Unlike the detector monkey-patches, this doesn't override an existing native API — it pollutes
  // the global namespace with a new handle, and only ever when `options.debug` is set.
  // https://developer.mozilla.org/en-US/docs/Web/API/Window
  /** @type {any} */ (win).__crashbox = {
    ...ctx.api,
    /** The crash record recovered on this load, or null. */
    recovered: () => ctx.getRecovered(),
    /** Parsed contents of every `crashbox:*` localStorage key. */
    dump: () => {
      const storage = getStorage();
      /** @type {Record<string, unknown>} */
      const out = {};
      if (storage) {
        for (const k of debugKeys(ctx.getKeyPrefix())) {
          const raw = storage.getItem(k);
          try {
            out[k] = raw === null ? null : JSON.parse(raw);
          } catch {
            out[k] = raw;
          }
        }
      }
      return out;
    },
    /** Wipe crashbox's localStorage keys (reset between tests). Returns the keys removed. */
    clear: () => {
      const storage = getStorage();
      const keys = debugKeys(ctx.getKeyPrefix());
      if (storage) {
        keys.forEach((k) => storage.removeItem(k));
      }
      return keys;
    },
  };
  // A single line so a dev knows the handle is live (debug-mode only — opt-in).
  try {
    console.info(
      "crashbox: debug handle at window.__crashbox (.dump/.status via getStatus/.recovered/.clear)",
    );
  } catch {
    // no console — fine
  }
};

/** Remove the `window.__crashbox` global augmentation added by `attachDebugHandle` (teardown). */
export const detachDebugHandle = () => {
  const win = getWindow();
  if (win && /** @type {any} */ (win).__crashbox) {
    try {
      delete (/** @type {any} */ (win).__crashbox);
    } catch {
      /** @type {any} */ (win).__crashbox = undefined; // non-configurable — null it out instead
    }
  }
};
