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

import {
  getWindow,
  unref,
  readJsHeap,
  readDeviceMemoryGB,
  measureAgentMemory,
} from "./env.js";

/**
 * @typedef {Object} DetectorContext
 * @property {(msg: string, data?: Record<string, unknown>) => void} breadcrumb
 * @property {import("./types.js").ResolvedOptions} options
 */

/**
 * @typedef {Object} Detector
 * @property {() => void} stop
 * @property {(device: GPUDevice) => void} [attachGPUDevice]
 * @property {(now: number) => void} [sample] Drive one sampler tick (memory sampler; for tests).
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
 * Memory-pressure severity cut-points (used/limit ratio → level). Compute-Pressure-aligned vocab
 * (`nominal`/`fair`/`serious`/`critical`) so an app already running a `PressureObserver` can forward
 * its `record.state` verbatim. Overridable via `options.memoryThresholds`.
 * @type {import("./types.js").MemoryThresholds}
 */
export const DEFAULT_MEMORY_THRESHOLDS = {
  fair: 0.7,
  serious: 0.85,
  critical: 0.95,
};

/** Severity ranking; `nominal` (0) means "no pressure" and only re-arms hysteresis (never warns). */
export const LEVEL_RANK = { nominal: 0, fair: 1, serious: 2, critical: 3 };

/** Memory-sampler cadence + the minimum gap before a still-elevated level may re-fire. */
const MEMORY_SAMPLE_MS = 2000;
export const MEMORY_REFIRE_MS = 30000;

/**
 * Budget fractions for the absolute byte thresholds. When a budget signal exists (an app-supplied
 * `memoryBudgetBytes`, else `performance.memory.jsHeapSizeLimit`, else `navigator.deviceMemory`),
 * the WASM/GPU growth thresholds become a fraction of that budget instead of a fixed 64/256 MB — so
 * a big machine stops false-positiving on routine allocations. With NO budget signal (iOS Safari)
 * the fixed bytes are kept unchanged. Overridable via `options.memoryThresholds`.
 */
const WASM_FLOOR_FRACTION = 0.25;
const WASM_BURST_FRACTION = 0.5;
const GPU_FLOOR_FRACTION = 0.25;
const GPU_BURST_FRACTION = 0.5;

/**
 * Map a used/budget ratio to a severity level. Pure (unit-tested directly).
 * @param {number} ratio
 * @param {{ fair?: number, serious?: number, critical?: number }} [thresholds]
 * @returns {"nominal" | "fair" | "serious" | "critical"}
 */
export const ratioToLevel = (ratio, thresholds = DEFAULT_MEMORY_THRESHOLDS) => {
  const critical = thresholds.critical ?? 0.95;
  const serious = thresholds.serious ?? 0.85;
  const fair = thresholds.fair ?? 0.7;
  if (ratio >= critical) {
    return "critical";
  }
  if (ratio >= serious) {
    return "serious";
  }
  if (ratio >= fair) {
    return "fair";
  }
  return "nominal";
};

/** @param {string} [level] @returns {number} */
export const levelRank = (level) =>
  level && level in LEVEL_RANK
    ? LEVEL_RANK[/** @type {keyof typeof LEVEL_RANK} */ (level)]
    : 0;

/**
 * Resolve the memory budget (denominator for pressure ratios + the absolute-threshold scaler).
 * Precedence: app-declared `memoryBudgetBytes` → `performance.memory.jsHeapSizeLimit` →
 * `navigator.deviceMemory` (GB) → `null` (no signal, e.g. iOS Safari). Pure-ish (reads guarded
 * globals via env.js). The app value wins because the browser numbers are coarse or clamped.
 * @param {{ memoryBudgetBytes?: number }} opts
 * @returns {number | null}
 */
export const resolveBudgetBytes = (opts) => {
  const declared = opts && opts.memoryBudgetBytes;
  if (typeof declared === "number" && declared > 0) {
    return declared;
  }
  const heap = readJsHeap();
  if (heap && heap.limitBytes > 0) {
    return heap.limitBytes;
  }
  const gb = readDeviceMemoryGB();
  if (typeof gb === "number" && gb > 0) {
    return gb * 1073741824;
  }
  return null;
};

/**
 * Scale an absolute byte threshold to a budget. `null` budget (no signal) returns the fixed floor
 * unchanged (preserves iOS behavior). Otherwise returns `max(fixed, budget * fraction)` — the
 * `max` guarantees we only ever get *quieter* on big machines, never noisier on small ones. Pure.
 * @param {number | null} budgetBytes
 * @param {number} fraction
 * @param {number} fixedFloorBytes
 * @returns {number}
 */
export const scaledFloorBytes = (budgetBytes, fraction, fixedFloorBytes) =>
  budgetBytes == null
    ? fixedFloorBytes
    : Math.max(fixedFloorBytes, Math.round(budgetBytes * fraction));

/**
 * Hysteresis gate shared by the sampler, the heartbeat pull source, and the central emitter — so a
 * level that holds steady warns once (not every tick). Fires on a RISING level, or on a steady
 * elevated level once `refireMs` has elapsed (so sustained pressure still leaves periodic markers
 * rather than going silent forever). Any DROP (incl. to `nominal`/rank 0) lowers the watermark
 * WITHOUT firing — so a later rise from the new, lower level fires again. Tracking the current
 * level rather than the session peak is what lets a fresh episode after a recovery (or a relapse to
 * a level below an earlier peak) warn at all. Mutates `state` in place on a fire/re-arm. Pure aside
 * from that mutation (unit-tested directly).
 * @param {number} rank
 * @param {number} now
 * @param {{ lastRank: number, lastFireTs: number }} state
 * @param {number} refireMs
 * @returns {boolean}
 */
export const shouldFirePressure = (rank, now, state, refireMs) => {
  if (rank < state.lastRank) {
    state.lastRank = rank; // descended — follow pressure down so a later rise re-fires
    return false;
  }
  const rising = rank > state.lastRank;
  // `rank > 0` keeps a steady `nominal` (rank 0) from ever firing on the refire path.
  const stale =
    rank === state.lastRank && rank > 0 && now - state.lastFireTs >= refireMs;
  if (!rising && !stale) {
    return false;
  }
  state.lastRank = rank;
  state.lastFireTs = now;
  return true;
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
 * Whether a watchdog tick should report a main-thread stall: the lateness crosses the threshold AND
 * the tab is foreground AND it wasn't hidden since the previous tick. A hidden tab has its timers
 * throttled (mobile Safari → ~1 tick/min) or fully suspended, so the "drift" is backgrounding, not a
 * hang. `wasHidden` covers the resume case where the suspended timer fires before the visibility
 * event flips `hidden` back to false. Pure (unit-tested directly).
 * @param {number} driftMs
 * @param {boolean} hidden    tab is hidden right now
 * @param {boolean} wasHidden tab was hidden at any point since the last tick (suppress the resume gap)
 * @returns {boolean}
 */
export const shouldReportStall = (driftMs, hidden, wasHidden) =>
  !hidden && !wasHidden && driftMs >= STALL_MS;

/**
 * JS / general detector: uncaught errors, unhandled rejections, and a main-thread watchdog (iOS
 * Safari has no `PerformanceObserver('longtask')`, so hang detection uses `setInterval` drift). The
 * error name is folded into the breadcrumb text so a `RangeError` surfaces as an `"oom"` reason on
 * the next load via `inference.REASON_SIGNALS`.
 *
 * The watchdog ignores hidden-tab time: a backgrounded tab throttles/suspends timers, so its drift
 * is backgrounding, not a hang. Ticks while `document.hidden` are skipped, and the drift baseline is
 * reset across any visibility change so the first foreground tick doesn't count time spent hidden.
 * @param {DetectorContext} ctx
 * @returns {Detector}
 */
const createJsDetector = (ctx) => {
  const win = getWindow();
  const doc = win ? win.document : null;

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
  let last = Date.now();
  // Whether the tab has been hidden since the last foreground watchdog tick. Set the instant the tab
  // goes hidden — that `visibilitychange` fires before iOS suspends the page — so on resume the
  // suspended timer's huge "drift" is suppressed even though it fires before the visible event flips
  // `document.hidden` back to false. The first foreground tick consumes the flag.
  let wasHidden = false;
  const onVisibility = () => {
    if (doc && doc.hidden) {
      wasHidden = true;
    }
  };

  if (win) {
    win.addEventListener("error", onError);
    win.addEventListener("unhandledrejection", onRejection);
    if (doc) {
      doc.addEventListener("visibilitychange", onVisibility);
    }
    watchdog = setInterval(() => {
      const now = Date.now();
      const drift = stallDriftMs(last, now, WATCHDOG_MS);
      last = now;
      const hidden = !!(doc && doc.hidden);
      const report = shouldReportStall(drift, hidden, wasHidden);
      // A hidden tick keeps the flag set (still backgrounded); the first foreground tick clears it.
      wasHidden = hidden;
      if (report) {
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
        if (doc) {
          doc.removeEventListener("visibilitychange", onVisibility);
        }
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

  // Budget-relative thresholds: on a machine with a known budget, a 64/256 MB commit is noise, so
  // scale the activity floor/burst up. With no budget signal (iOS) the fixed bytes are kept.
  const budget = resolveBudgetBytes(ctx.options);
  const memThresholds =
    ctx.options.memoryThresholds || DEFAULT_MEMORY_THRESHOLDS;
  const gpuFloor = scaledFloorBytes(
    budget,
    memThresholds.gpuFloorFraction ?? GPU_FLOOR_FRACTION,
    GPU_FLOOR_BYTES,
  );
  const gpuBurst = scaledFloorBytes(
    budget,
    memThresholds.gpuBurstFraction ?? GPU_BURST_FRACTION,
    GPU_BURST_BYTES,
  );

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
        if (pendingBytes < gpuFloor) {
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
          if (pendingBytes >= gpuBurst) {
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

  // Budget-relative thresholds (see createWebgpuDetector). `null` budget (iOS) keeps fixed bytes.
  const budget = resolveBudgetBytes(ctx.options);
  const memThresholds =
    ctx.options.memoryThresholds || DEFAULT_MEMORY_THRESHOLDS;
  const wasmFloor = scaledFloorBytes(
    budget,
    memThresholds.wasmFloorFraction ?? WASM_FLOOR_FRACTION,
    WASM_FLOOR_BYTES,
  );
  const wasmBurst = scaledFloorBytes(
    budget,
    memThresholds.wasmBurstFraction ?? WASM_BURST_FRACTION,
    WASM_BURST_BYTES,
  );

  /** @param {import("./types.js").MemoryPressureInfo} info */
  const firePressure = (info) => {
    const cb = ctx.options.onMemoryPressure;
    if (cb) {
      try {
        cb(info);
      } catch {
        // a throwing app callback must not break the detector
      }
    }
  };

  const flush = () => {
    if (pendingBytes < wasmFloor) {
      pendingBytes = 0;
      return;
    }
    committedMB += Math.round(pendingBytes / 1048576);
    ctx.breadcrumb(`wasm memory: ~${committedMB} MB committed`, {
      signal: "memory-near-cap",
      committedMB,
    });
    // WASM growth can't compute a true used/budget ratio (it only sees its own linear memory), so
    // be honest: report a coarse "serious" with committed bytes, not a fabricated ratio.
    firePressure({
      source: "wasm-growth",
      level: "serious",
      committedBytes: committedMB * 1048576,
      budgetBytes: budget,
    });
    pendingBytes = 0;
  };

  /** @this {any} @param {number} delta */
  const trackedGrow = function (delta) {
    let result;
    /** @type {any} */
    let threw = null;
    try {
      result = originalGrow.call(this, delta);
    } catch (e) {
      threw = e;
    }
    try {
      if (threw) {
        const name = (threw && threw.name) || "error";
        ctx.breadcrumb(`wasm memory.grow failed: ${name}`, {
          signal: "memory-near-cap",
        });
        // A failed grow IS out-of-memory — the strongest signal, fired unconditionally (unscaled).
        firePressure({
          source: "wasm-growth",
          level: "critical",
          budgetBytes: budget,
        });
      } else {
        const bytes = this.buffer.byteLength;
        const prev = sizes.get(this) || 0;
        if (bytes > prev) {
          pendingBytes += bytes - prev;
          sizes.set(this, bytes);
        }
        if (pendingBytes >= wasmBurst) {
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
 * Memory sampler. The budget-relative counterpart to the WASM/GPU growth detectors: on Chromium it
 * polls `performance.memory` (cheap, sync) each cadence and reports a leveled `onMemoryPressure`
 * when the used/limit ratio crosses a threshold — the only *real* (not growth-proxy) pressure signal
 * the platform offers. Where `performance.memory` is absent (iOS Safari, Firefox, Node) it's a
 * no-op, so the WASM detector remains the fallback there. Hysteresis (`shouldFirePressure`) keeps a
 * steady level from spamming the breadcrumb trail; an infrequent `measureUserAgentSpecificMemory()`
 * cross-check enriches the next fire with a cross-worker total when available. Allocation-light: the
 * hot path is two reads + a divide + a compare; an info object is built only on a level CHANGE (a
 * rise/refire fire, or a descent forwarded to re-arm the shared downstream gate — see below).
 * @param {DetectorContext} ctx
 * @returns {Detector}
 */
const createMemorySampler = (ctx) => {
  if (!readJsHeap()) {
    return { stop() {} }; // no performance.memory → nothing to sample (iOS/Firefox/Node)
  }
  let stopped = false;
  const thresholds = ctx.options.memoryThresholds || DEFAULT_MEMORY_THRESHOLDS;
  const sampleMs = ctx.options.memorySampleMs ?? MEMORY_SAMPLE_MS;
  const gate = { lastRank: 0, lastFireTs: 0 };
  let lastAgentTs = 0;
  /** @type {number | null} */
  let agentBytes = null;

  /** Infrequent, fire-and-forget cross-check; result enriches the NEXT fire. @param {number} now */
  const maybeMeasureAgent = (now) => {
    if (now - lastAgentTs < MEMORY_REFIRE_MS) {
      return;
    }
    lastAgentTs = now;
    measureAgentMemory()
      .then((bytes) => {
        if (!stopped && typeof bytes === "number") {
          agentBytes = bytes;
        }
      })
      .catch(() => {});
  };

  /** @param {number} now */
  const sample = (now) => {
    const heap = readJsHeap();
    if (!heap || !(heap.limitBytes > 0)) {
      return;
    }
    const ratio = heap.usedBytes / heap.limitBytes;
    const level = ratioToLevel(ratio, thresholds);
    const rank = levelRank(level);
    const prevRank = gate.lastRank;
    if (!shouldFirePressure(rank, now, gate, MEMORY_REFIRE_MS)) {
      // Not a rising-edge/refire. If pressure DESCENDED this tick, still forward the lower level
      // (silently — no breadcrumb) so the downstream central gate, which `onMemoryPressure` shares,
      // tracks the recovery and a later rise can re-fire. Without this the central gate would latch
      // at the session peak and go silent for every subsequent lower-severity episode. A steady,
      // unchanged level is dropped entirely — that throttling is the breadcrumb-spam guard.
      if (rank < prevRank) {
        firePressureCb(ctx, {
          source: "performance.memory",
          level,
          ratio,
          usedBytes: heap.usedBytes,
          limitBytes: heap.limitBytes,
        });
      }
      if (rank > 0) {
        maybeMeasureAgent(now); // elevated but throttled — keep the cross-check warm
      }
      return;
    }
    ctx.breadcrumb(
      `memory pressure: ${level} (${Math.round(ratio * 100)}% of heap limit)`,
      {
        signal: "memory-near-cap",
        level,
        ratio: Math.round(ratio * 1000) / 1000,
        usedBytes: heap.usedBytes,
        limitBytes: heap.limitBytes,
        source: "performance.memory",
        ...(agentBytes != null ? { agentMemoryBytes: agentBytes } : {}),
      },
    );
    firePressureCb(ctx, {
      source: "performance.memory",
      level,
      ratio,
      usedBytes: heap.usedBytes,
      limitBytes: heap.limitBytes,
      ...(agentBytes != null ? { agentMemoryBytes: agentBytes } : {}),
    });
    maybeMeasureAgent(now);
  };

  const timer = setInterval(() => {
    if (!stopped) {
      sample(Date.now());
    }
  }, sampleMs);
  unref(timer);

  return {
    // Exposed for direct unit tests (drive a tick without waiting on the timer).
    sample,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
};

/**
 * Invoke `onMemoryPressure` defensively (a throwing app callback must not break a detector).
 * @param {DetectorContext} ctx
 * @param {import("./types.js").MemoryPressureInfo} info
 */
const firePressureCb = (ctx, info) => {
  const cb = ctx.options.onMemoryPressure;
  if (cb) {
    try {
      cb(info);
    } catch {
      // swallow — enrichment must never break the host app
    }
  }
};

/**
 * Detector factories by name. All are registered; an unknown name is a noted no-op (a breadcrumb),
 * never a throw.
 * @type {Partial<Record<import("./types.js").DetectorName, (ctx: DetectorContext) => Detector>>}
 */
const REGISTRY = {
  js: createJsDetector,
  webgpu: createWebgpuDetector,
  wasm: createWasmDetector,
  memory: createMemorySampler,
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
