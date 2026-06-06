// Detectors — enrichment, not the crash catch (hard kills have no live event; the crash itself is
// caught by inference on the next load). Each detector observes its source, drops breadcrumbs, and
// fires early-warning callbacks. Enabled per `options.detectors` (default ["js"]; webgpu/wasm
// opt-in). Kept in one file — they share a tiny shape.
//
//  - js: onerror + onunhandledrejection. iOS Safari has no PerformanceObserver 'longtask', so hang
//        detection uses a main-thread watchdog (setInterval drift).
//  - webgpu: wrap GPUDevice. device.lost reason "destroyed" = intentional; a real GPU OOM hard-kills
//        with no device.lost, but emits GPUOutOfMemoryError (uncapturederror) seconds before → that
//        fires onDeviceLossImminent.
//  - wasm: track WebAssembly.Memory growth — the only memory-pressure signal on iOS (no
//        performance.memory / measureUserAgentSpecificMemory) → onMemoryPressure.

import { getWindow, unref } from "./env.js";

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

/**
 * WebGPU activity log: flush cadence, the committed-bytes floor per window that counts as real
 * memory pressure (filters out routine light GPU use), and the single-window burst size that
 * flushes early (so a sub-second commit flood still leaves a marker before a kill).
 */
const GPU_ACTIVITY_MS = 2000;
const GPU_FLOOR_BYTES = 64 * 1048576;
const GPU_BURST_BYTES = 256 * 1048576;

/** WASM linear-memory growth thresholds — same shape as the GPU activity log. */
const WASM_GROWTH_MS = 2000;
const WASM_FLOOR_BYTES = 64 * 1048576;
const WASM_BURST_BYTES = 256 * 1048576;

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
 * JS / general detector: uncaught errors, unhandled rejections, and a main-thread watchdog (iOS
 * Safari has no `PerformanceObserver('longtask')`, so hang detection uses `setInterval` drift). The
 * error name is folded into the breadcrumb text so a `RangeError` surfaces as an `"oom"` reason on
 * the next load via `inference.REASON_SIGNALS`.
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
 * WebGPU detector. Wraps a `GPUDevice` to:
 *  - breadcrumb `device.lost`, distinguishing intentional `reason:"destroyed"` (NOT a crash) from
 *    unexpected loss (tagged `webgpu-device-lost`);
 *  - surface `uncapturederror` — a `GPUOutOfMemoryError` precedes a hard tab kill by seconds, so it
 *    fires `onDeviceLossImminent` and drops a `webgpu-device-lost` marker for the next load's
 *    inference; a `GPUValidationError` (e.g. over-limit buffer) is enrichment;
 *  - proactively flag a `createBuffer` request larger than `limits.maxBufferSize`.
 * A real GPU OOM takes the whole tab down with NO `device.lost`, so the crash itself is caught by
 * next-load inference; this detector provides the early warning + the breadcrumb trail.
 * @param {DetectorContext} ctx
 * @returns {Detector}
 */
const createWebgpuDetector = (ctx) => {
  let stopped = false;
  /** @type {Array<() => void>} */
  const teardowns = [];

  /** @param {{ reason?: string }} info */
  const fireImminent = (info) => {
    const cb = ctx.options.onDeviceLossImminent;
    if (cb) {
      try {
        cb(info);
      } catch {
        // a throwing app callback must not break the detector
      }
    }
  };

  /** @param {any} err @returns {string} */
  const errName = (err) => {
    if (!err) {
      return "";
    }
    if (err.constructor && err.constructor.name) {
      return err.constructor.name;
    }
    return String(err.name || "");
  };

  /** @param {GPUDevice} device */
  const attach = (device) => {
    if (stopped || !device) {
      return;
    }
    const dev = /** @type {any} */ (device);

    if (dev.lost && typeof dev.lost.then === "function") {
      dev.lost
        .then(
          /** @param {any} info */ (info) => {
            if (stopped) {
              return;
            }
            const reason = info && info.reason;
            if (reason === "destroyed") {
              // Intentional teardown — keep loss markers out of the msg so classifyReason
              // can't later misread it as a crash cause.
              ctx.breadcrumb("webgpu device destroyed (intentional)", {
                reason,
              });
            } else {
              ctx.breadcrumb(`webgpu device.lost: ${reason || "unknown"}`, {
                signal: "webgpu-device-lost",
                reason,
                message: info && info.message,
              });
            }
          },
        )
        .catch(() => {});
    }

    /** @param {any} e */
    const onError = (e) => {
      if (stopped) {
        return;
      }
      const err = e && e.error;
      const name = errName(err);
      const message = (err && err.message) || "";
      if (name.includes("OutOfMemory")) {
        ctx.breadcrumb(
          `webgpu uncapturederror: GPUOutOfMemoryError ${message}`.trim(),
          { signal: "webgpu-device-lost" },
        );
        fireImminent({ reason: "out-of-memory" });
      } else {
        ctx.breadcrumb(
          `webgpu uncapturederror: ${name || "error"} ${message}`.trim(),
          { kind: name },
        );
      }
    };
    if (typeof dev.addEventListener === "function") {
      dev.addEventListener("uncapturederror", onError);
    }

    let restoreCreateBuffer = () => {};
    if (typeof dev.createBuffer === "function") {
      const original = dev.createBuffer.bind(dev);
      /** @param {any} descriptor */
      const wrapped = (descriptor) => {
        try {
          const max = dev.limits && dev.limits.maxBufferSize;
          if (typeof max === "number" && descriptor && descriptor.size > max) {
            ctx.breadcrumb(
              `webgpu oversized buffer: ${descriptor.size} > maxBufferSize ${max}`,
              { signal: "gpu-oversized-buffer", size: descriptor.size },
            );
            fireImminent({ reason: "oversized-buffer" });
          }
        } catch {
          // never break the host app's createBuffer
        }
        return original(descriptor);
      };
      // MONKEY-PATCH: GPUDevice.createBuffer (per-instance) — replace with a wrapper that
      // inspects the descriptor then forwards to the saved `original`. Reverted by
      // `restoreCreateBuffer()` on teardown.
      // https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createBuffer
      dev.createBuffer = wrapped;
      restoreCreateBuffer = () => {
        if (dev.createBuffer === wrapped) {
          dev.createBuffer = original;
        }
      };
    }

    // Rolling GPU-activity log (throttled). A committed OOM can hard-kill sub-second with no
    // uncapturederror, so without this the trail carries no webgpu marker and the crash
    // misclassifies as hard-kill. We breadcrumb only under real memory pressure — ≥ GPU_FLOOR_BYTES
    // committed per window, or a ≥ GPU_BURST_BYTES burst — so routine light GPU use stays out of the
    // trail and can't hijack an unrelated crash's reason.
    let stopActivity = () => {};
    if (dev.queue && typeof dev.queue.writeBuffer === "function") {
      const queue = dev.queue;
      let pendingBytes = 0;
      let pendingSubmits = 0;
      let committedMB = 0;
      const flushActivity = () => {
        if (pendingBytes < GPU_FLOOR_BYTES) {
          pendingBytes = 0;
          pendingSubmits = 0;
          return;
        }
        committedMB += Math.round(pendingBytes / 1048576);
        ctx.breadcrumb(
          `webgpu activity: ~${committedMB} MB committed (${pendingSubmits} submits)`,
          { signal: "webgpu-device-lost", committedMB },
        );
        pendingBytes = 0;
        pendingSubmits = 0;
      };

      const originalWrite = queue.writeBuffer.bind(queue);
      /** @param {any[]} args */
      const wrappedWrite = (...args) => {
        try {
          const data = args[2];
          pendingBytes += (data && (data.byteLength || data.length)) || 0;
          if (pendingBytes >= GPU_BURST_BYTES) {
            flushActivity();
          }
        } catch {
          // never break the host app's writeBuffer
        }
        return originalWrite(...args);
      };
      // MONKEY-PATCH: GPUQueue.writeBuffer (per-instance) — wrap to tally committed bytes,
      // then forward to the saved `originalWrite`. Reverted by `stopActivity()` on teardown.
      // https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/writeBuffer
      queue.writeBuffer = wrappedWrite;

      /** @type {Function | null} */
      let originalSubmit = null;
      /** @type {Function | null} */
      let wrappedSubmit = null;
      if (typeof queue.submit === "function") {
        const origSubmit = queue.submit.bind(queue);
        originalSubmit = origSubmit;
        /** @param {any[]} args */
        wrappedSubmit = (...args) => {
          pendingSubmits += 1;
          return origSubmit(...args);
        };
        // MONKEY-PATCH: GPUQueue.submit (per-instance) — wrap to count submits, then forward
        // to the saved `origSubmit`. Reverted by `stopActivity()` on teardown.
        // https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/submit
        queue.submit = wrappedSubmit;
      }

      const timer = setInterval(() => {
        if (!stopped) {
          flushActivity();
        }
      }, GPU_ACTIVITY_MS);
      unref(timer);

      stopActivity = () => {
        clearInterval(timer);
        if (queue.writeBuffer === wrappedWrite) {
          queue.writeBuffer = originalWrite;
        }
        if (wrappedSubmit && queue.submit === wrappedSubmit) {
          queue.submit = originalSubmit;
        }
      };
    }

    teardowns.push(() => {
      if (typeof dev.removeEventListener === "function") {
        dev.removeEventListener("uncapturederror", onError);
      }
      restoreCreateBuffer();
      stopActivity();
    });
  };

  return {
    attachGPUDevice: attach,
    stop() {
      stopped = true;
      for (const t of teardowns) {
        try {
          t();
        } catch {
          // best-effort teardown
        }
      }
      teardowns.length = 0;
    },
  };
};

/**
 * WASM detector. `WebAssembly.Memory` growth is the only memory-pressure signal on iOS (no
 * `performance.memory` / `measureUserAgentSpecificMemory`). Wraps
 * `WebAssembly.Memory.prototype.grow` to track total committed linear memory across instances;
 * under real pressure it fires `onMemoryPressure` and breadcrumbs `wasm memory: ~N MB committed`
 * (signal `memory-near-cap` → `"oom"`), so a WASM OOM that hard-kills the tab with no event
 * recovers as `oom` from the trail. A failed grow (`RangeError`) is also breadcrumbed and
 * re-thrown. Throttled like the GPU activity log: a ≥`WASM_BURST_BYTES` jump flushes immediately,
 * else ≥`WASM_FLOOR_BYTES` per window. (JS-initiated grows — incl. emscripten's
 * `_emscripten_resize_heap` — are caught; pure module-internal `memory.grow` is not.)
 * @param {DetectorContext} ctx
 * @returns {Detector}
 */
const createWasmDetector = (ctx) => {
  let stopped = false;
  if (typeof WebAssembly === "undefined" || !WebAssembly.Memory) {
    return { stop() {} };
  }
  const proto = /** @type {any} */ (WebAssembly.Memory.prototype);
  const originalGrow = proto.grow;
  /** @type {WeakMap<object, number>} */
  const sizes = new WeakMap();
  let pendingBytes = 0;
  let committedMB = 0;

  const firePressure = () => {
    const cb = ctx.options.onMemoryPressure;
    if (cb) {
      try {
        cb();
      } catch {
        // a throwing app callback must not break the detector
      }
    }
  };

  const flush = () => {
    if (pendingBytes < WASM_FLOOR_BYTES) {
      pendingBytes = 0;
      return;
    }
    committedMB += Math.round(pendingBytes / 1048576);
    ctx.breadcrumb(`wasm memory: ~${committedMB} MB committed`, {
      signal: "memory-near-cap",
      committedMB,
    });
    firePressure();
    pendingBytes = 0;
  };

  /** @this {any} @param {number} delta */
  const trackedGrow = function (delta) {
    let result;
    let threw = null;
    try {
      result = originalGrow.call(this, delta);
    } catch (/** @type {any} */ e) {
      threw = e;
    }
    try {
      if (threw) {
        const name = (threw && threw.name) || "error";
        ctx.breadcrumb(`wasm memory.grow failed: ${name}`, {
          signal: "memory-near-cap",
        });
        firePressure();
      } else {
        const bytes = this.buffer.byteLength;
        const prev = sizes.get(this) || 0;
        if (bytes > prev) {
          pendingBytes += bytes - prev;
          sizes.set(this, bytes);
        }
        if (pendingBytes >= WASM_BURST_BYTES) {
          flush();
        }
      }
    } catch {
      // never break the host app's memory.grow
    }
    if (threw) {
      throw threw;
    }
    return result;
  };
  // MONKEY-PATCH: WebAssembly.Memory.prototype.grow — replace with a wrapper that forwards to
  // the saved `originalGrow`, then tracks growth. NOTE: this is a PROTOTYPE patch, so it affects
  // EVERY WebAssembly.Memory in the realm (not one instance) — which is why `stop()` must revert
  // it back to `originalGrow` on teardown.
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/Memory/grow
  proto.grow = trackedGrow;

  const timer = setInterval(() => {
    if (!stopped) {
      flush();
    }
  }, WASM_GROWTH_MS);
  unref(timer);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (proto.grow === trackedGrow) {
        proto.grow = originalGrow;
      }
    },
  };
};

/**
 * Detector factories by name. All three are registered; an unknown name is a noted no-op (a
 * breadcrumb), never a throw.
 * @type {Partial<Record<import("./types.js").DetectorName, (ctx: DetectorContext) => Detector>>}
 */
const REGISTRY = {
  js: createJsDetector,
  webgpu: createWebgpuDetector,
  wasm: createWasmDetector,
};

/**
 * Enable the detectors named in ctx.options.detectors. Returns handles for teardown +
 * GPU-device attachment. An unknown detector name is skipped with a breadcrumb (defensive —
 * js/webgpu/wasm are all registered).
 * @param {DetectorContext} ctx
 * @returns {Detector[]}
 */
export const enableDetectors = (ctx) => {
  /** @type {Detector[]} */
  const handles = [];
  for (const name of ctx.options.detectors) {
    const make = REGISTRY[name];
    if (!make) {
      ctx.breadcrumb(`crashbox: unknown detector "${name}"`, {
        signal: "detector-unavailable",
      });
      continue;
    }
    handles.push(make(ctx));
  }
  return handles;
};
