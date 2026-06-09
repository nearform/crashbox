// Guarded access to browser globals. Every accessor is try/catch-wrapped and returns a safe
// fallback when the global is absent or throws (privacy modes, Node/SSR) — so importing and
// `init`-ing crashbox outside a browser degrades to an in-memory no-op rather than throwing.
// Shared by index.js (the spine) and detectors.js (which needs window + unref too).

/** @returns {Storage | null} */
export const getStorage = () => {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null; // access can throw under some privacy modes
  }
};

/** @returns {Window | null} */
export const getWindow = () => {
  try {
    return typeof window !== "undefined" ? window : null;
  } catch {
    return null;
  }
};

/** iOS tab-discard flag. Experimental and absent from lib.dom, so read defensively. */
export const getWasDiscarded = () => {
  try {
    return (
      typeof document !== "undefined" &&
      /** @type {any} */ (document).wasDiscarded === true
    );
  } catch {
    return false;
  }
};

/** The Navigation Timing `type` ("navigate" | "reload" | "back_forward" | …), or undefined. */
/** @returns {string | undefined} */
export const getNavType = () => {
  try {
    const entries =
      typeof performance !== "undefined" && performance.getEntriesByType
        ? performance.getEntriesByType("navigation")
        : [];
    const nav = /** @type {PerformanceNavigationTiming | undefined} */ (
      entries[0]
    );
    return nav ? nav.type : undefined;
  } catch {
    return undefined;
  }
};

/**
 * JS heap usage from the non-standard `performance.memory` (Chromium only — absent on iOS Safari
 * and Firefox). Cheap and synchronous, so it's the hot-path source for the memory sampler. The
 * `usedBytes/limitBytes` ratio is the only real memory-pressure proxy the platform offers.
 * (`totalJSHeapSize` is deliberately omitted — nothing consumes it, and it's not reliably present.)
 * @returns {{ usedBytes: number, limitBytes: number } | null}
 */
export const readJsHeap = () => {
  try {
    const mem = /** @type {any} */ (
      typeof performance !== "undefined" ? performance : undefined
    )?.memory;
    if (
      mem &&
      typeof mem.usedJSHeapSize === "number" &&
      typeof mem.jsHeapSizeLimit === "number"
    ) {
      return {
        usedBytes: mem.usedJSHeapSize,
        limitBytes: mem.jsHeapSizeLimit,
      };
    }
  } catch {
    // performance.memory access can throw in some sandboxes
  }
  return null;
};

/**
 * Approximate device RAM in GB from `navigator.deviceMemory` (Chromium only; a static, power-of-2
 * tier clamped to 8 for fingerprint resistance). A coarse budget fallback when `performance.memory`
 * is absent — never precise enough to be authoritative over an app-supplied budget.
 * @returns {number | null}
 */
export const readDeviceMemoryGB = () => {
  try {
    const gb = /** @type {any} */ (
      typeof navigator !== "undefined" ? navigator : undefined
    )?.deviceMemory;
    return typeof gb === "number" && gb > 0 ? gb : null;
  } catch {
    return null;
  }
};

/**
 * Total page memory (incl. workers/iframes) via `performance.measureUserAgentSpecificMemory()`.
 * Chromium only, async, and gated on `crossOriginIsolated` — and absent on iOS Safari even when
 * isolated. Resolves to `null` (never rejects) when unavailable. Expensive: call infrequently and
 * never from a hot path.
 * @returns {Promise<number | null>}
 */
export const measureAgentMemory = async () => {
  try {
    const perf = /** @type {any} */ (
      typeof performance !== "undefined" ? performance : undefined
    );
    const isolated =
      /** @type {any} */ (globalThis).crossOriginIsolated === true;
    if (
      !perf ||
      !isolated ||
      typeof perf.measureUserAgentSpecificMemory !== "function"
    ) {
      return null;
    }
    const result = await perf.measureUserAgentSpecificMemory();
    return result && typeof result.bytes === "number" ? result.bytes : null;
  } catch {
    return null; // rejects (e.g. not isolated) degrade to "no signal"
  }
};

/** A unique session id: `crypto.randomUUID()` where available, else a timestamp+random fallback. */
export const makeSessionId = () => {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the non-crypto id
  }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * Return `data` if JSON-safe, else a marker — keeps the persisted record always serializable
 * so one poison breadcrumb can't permanently break the write path.
 * @param {Record<string, unknown>} data
 * @returns {Record<string, unknown>}
 */
export const jsonSafe = (data) => {
  try {
    JSON.stringify(data);
    return data;
  } catch {
    return { "[unserializable]": true };
  }
};

/** Don't let a watchdog/heartbeat timer keep a Node process alive (no-op in the browser). @param {unknown} id */
export const unref = (id) => {
  /** @type {any} */ (id)?.unref?.();
};
