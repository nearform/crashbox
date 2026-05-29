// crashbox public API (SPEC §5). Phase 0 implements the surface as safe no-ops that
// resolve + hold options; the durable store, heartbeat, detectors, and recovery are
// wired in Phases 2–3 from the modules under src/ (recorder, heartbeat, registry,
// inference/recover). Keeping the API real from day one stabilizes the contract + types.

/** @typedef {import("./types.js").CrashboxOptions} CrashboxOptions */
/** @typedef {import("./types.js").CrashRecord} CrashRecord */
/** @typedef {import("./types.js").Snapshot} Snapshot */
/** @typedef {import("./types.js").ResolvedOptions} ResolvedOptions */

/**
 * Default options. Values chosen from the research spikes:
 * - `heartbeatMs` 2000 — SPEC default cadence.
 * - `breadcrumbLimit` 100 — SPEC default; trivially within the ~38 GB iOS quota (research §6/#9).
 * - `snapshotMaxBytes` 32768 — JSON snapshot cap; sub-50µs to serialize at this size (research §8 #7).
 * - `detectors` ["js"] — JS detector default-on; webgpu/wasm are opt-in.
 * @type {ResolvedOptions}
 */
export const DEFAULTS = {
  heartbeatMs: 2000,
  breadcrumbLimit: 100,
  snapshotMaxBytes: 32768,
  detectors: ["js"],
};

/** @type {ResolvedOptions | null} */
let active = null;

/**
 * Initialize crashbox.
 * @param {CrashboxOptions} [options]
 * @returns {void}
 */
export const init = (options = {}) => {
  active = { ...DEFAULTS, ...options };
  // Phase 2-3: createCompositeStore(createIdbStore, createLocalStore)
  //   → createRecorder + createHeartbeat → enableDetectors
  //   → recover() and, if a CrashRecord results, active.onCrashRecovered(record).
};

/**
 * Record a breadcrumb. Must be cheap; no allocation beyond the entry.
 * @param {string} msg
 * @param {Record<string, unknown>} [data]
 * @returns {void}
 */
export const breadcrumb = (msg, data) => {
  void msg;
  void data; // Phase 2: recorder.breadcrumb(msg, data)
};

/**
 * Provide/replace the current state snapshot (JSON-serialized + size-capped before persist).
 * @param {Snapshot} state
 * @returns {void}
 */
export const setSnapshot = (state) => {
  void state; // Phase 2: recorder.setSnapshot(state)
};

/**
 * Register a WebGPU device so the detector can wrap it. No-op unless the `webgpu`
 * detector is enabled (Phase 5).
 * @param {GPUDevice} device
 * @returns {void}
 */
export const attachGPUDevice = (device) => {
  void device; // Phase 5: webgpuDetector.attach(device)
};

/**
 * The active resolved options, or null before `init`. Exposed for tests/introspection.
 * @returns {ResolvedOptions | null}
 */
export const getActiveOptions = () => active;
