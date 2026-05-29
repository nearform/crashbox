// Detectors — enrichment, not the crash catch (hard kills have no live event; the crash
// itself is caught by inference on the next load). Each detector observes its source, drops
// breadcrumbs, and fires early-warning callbacks. Enabled per `options.detectors` (default
// ["js"]; webgpu/wasm opt-in). Kept in one file — inline-able since they share a tiny shape.
//
// Research-driven specifics:
//  - js: onerror + onunhandledrejection. iOS Safari has NO PerformanceObserver 'longtask'
//        (research §6) → hang detection uses a main-thread watchdog (setInterval drift).
//  - webgpu: wrap GPUDevice. device.lost reason "destroyed" = intentional; a real GPU OOM
//        hard-kills with NO device.lost, but emits GPUOutOfMemoryError (uncapturederror)
//        seconds before → that fires onDeviceLossImminent (research §8 #3/#4).
//  - wasm: track WebAssembly.Memory growth — the ONLY memory-pressure signal on iOS
//        (research §6: no performance.memory / measureUserAgentSpecificMemory) → onMemoryPressure.

/**
 * @typedef {Object} DetectorContext
 * @property {(msg: string, data?: Record<string, unknown>) => void} breadcrumb
 * @property {import("./types.js").ResolvedOptions} options
 */

/**
 * @typedef {Object} Detector
 * @property {() => void} stop
 * @property {(device: GPUDevice) => void} [attachGPUDevice]
 */

/** Watchdog cadence + the lateness past it that we treat as a main-thread stall. */
const WATCHDOG_MS = 1000;
const STALL_MS = 250;

/** @returns {Window | null} */
const getWindow = () => {
  try {
    return typeof window !== "undefined" ? window : null;
  } catch {
    return null;
  }
};

/** Don't let a watchdog/timer keep a Node process alive (no-op in the browser). @param {unknown} id */
const unref = (id) => {
  /** @type {any} */ (id)?.unref?.();
};

/**
 * Lateness of a watchdog tick — how long the main thread was blocked beyond the interval.
 * Pure (unit-tested directly); the watchdog breadcrumbs when this crosses `STALL_MS`.
 * @param {number} prevTs
 * @param {number} nowTs
 * @param {number} intervalMs
 * @returns {number}
 */
export const stallDriftMs = (prevTs, nowTs, intervalMs) =>
  Math.max(0, nowTs - prevTs - intervalMs);

/**
 * JS / general detector: uncaught errors, unhandled rejections, and a main-thread watchdog
 * (iOS Safari has no `PerformanceObserver('longtask')` — research §6 — so hang detection uses
 * `setInterval` drift). The error name is folded into the breadcrumb text so a `RangeError`
 * surfaces as an `"oom"` reason on the next load via `inference.REASON_SIGNALS`.
 * @param {DetectorContext} ctx
 * @returns {Detector}
 */
const createJsDetector = (ctx) => {
  const win = getWindow();

  /** @param {ErrorEvent} e */
  const onError = (e) => {
    const err = e && e.error;
    // Prefer error.message (just the text); Safari's ErrorEvent.message already includes the
    // name, so using it under the name prefix doubles up ("RangeError: RangeError: …").
    const name = err && err.name ? `${err.name}: ` : "";
    const message = (err && err.message) || (e && e.message) || "error";
    ctx.breadcrumb(`js error: ${name}${message}`, {
      source: e && e.filename,
      line: e && e.lineno,
      stack: err && err.stack,
    });
  };

  /** @param {PromiseRejectionEvent} e */
  const onRejection = (e) => {
    const reason = e && e.reason;
    const name = reason && reason.name ? `${reason.name}: ` : "";
    const message = reason && reason.message ? reason.message : String(reason);
    ctx.breadcrumb(`unhandled rejection: ${name}${message}`, {
      stack: reason && reason.stack,
    });
  };

  /** @type {ReturnType<typeof setInterval> | null} */
  let watchdog = null;

  if (win) {
    win.addEventListener("error", onError);
    win.addEventListener("unhandledrejection", onRejection);
    let last = Date.now();
    watchdog = setInterval(() => {
      const now = Date.now();
      const drift = stallDriftMs(last, now, WATCHDOG_MS);
      last = now;
      if (drift >= STALL_MS) {
        ctx.breadcrumb(`main-thread stall ${Math.round(drift)}ms`, {
          signal: "hang",
          driftMs: Math.round(drift),
        });
      }
    }, WATCHDOG_MS);
    unref(watchdog);
  }

  return {
    stop() {
      if (win) {
        win.removeEventListener("error", onError);
        win.removeEventListener("unhandledrejection", onRejection);
      }
      if (watchdog !== null) {
        clearInterval(watchdog);
        watchdog = null;
      }
    },
  };
};

/**
 * Detector factories by name. `webgpu` (Phase 5) and `wasm` (Phase 6) are not registered yet;
 * requesting them is a noted no-op (a breadcrumb), never a throw.
 * @type {Partial<Record<import("./types.js").DetectorName, (ctx: DetectorContext) => Detector>>}
 */
const REGISTRY = {
  js: createJsDetector,
};

/**
 * Enable the detectors named in ctx.options.detectors. Returns handles for teardown +
 * GPU-device attachment. Unimplemented detectors are skipped with a breadcrumb.
 * @param {DetectorContext} ctx
 * @returns {Detector[]}
 */
export const enableDetectors = (ctx) => {
  /** @type {Detector[]} */
  const handles = [];
  for (const name of ctx.options.detectors) {
    const make = REGISTRY[name];
    if (!make) {
      ctx.breadcrumb(`crashbox: detector "${name}" not yet implemented`, {
        signal: "detector-unavailable",
      });
      continue;
    }
    handles.push(make(ctx));
  }
  return handles;
};
