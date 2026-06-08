// Central JSDoc @typedef hub for crashbox. Other modules reference these via
// `import("./types.js").TypeName`. Typedef-only module (no runtime exports).

/**
 * Inferred cause of a previous-session crash.
 * @typedef {"webgpu-device-lost" | "oom" | "hard-kill" | "unknown"} CrashReason
 */

/**
 * A single breadcrumb. Must stay tiny — the hot path allocates only this.
 * @typedef {Object} Breadcrumb
 * @property {number} t       Epoch ms when recorded.
 * @property {string} msg     Short message.
 * @property {Record<string, unknown>} [data] Optional small structured payload.
 */

/**
 * The recovered "black box" surfaced to the embedding app on the next load.
 * @typedef {Object} CrashRecord
 * @property {string} sessionId            The crashed session's id.
 * @property {CrashReason} reason          Inferred cause.
 * @property {number} lastSeen             Epoch ms of the final heartbeat (est. time of death).
 * @property {Breadcrumb[]} breadcrumbs    Tail of the ring buffer.
 * @property {Record<string, unknown> | undefined} snapshot Last app-provided snapshot (JSON-safe).
 */
// NOTE: a `corroborated` flag (Reporting API crash report confirming the reason) is deferred to a
// future version — see docs/work/FUTURE_WORK.md.

/**
 * App-provided state snapshot. Must be JSON-serializable: no cycles, functions, Maps, or typed
 * arrays — those are dropped/throw. Size-capped before persist.
 * @typedef {Record<string, unknown>} Snapshot
 */

/**
 * Which detectors to enable. `js` is the default; `webgpu`/`wasm`/`memory` are opt-in. `memory`
 * polls `performance.memory` (Chromium only — a no-op elsewhere).
 * @typedef {"webgpu" | "wasm" | "js" | "memory"} DetectorName
 */

/**
 * Memory-pressure severity. Compute-Pressure-API-aligned (`PressureObserver` `record.state`), so an
 * app already observing pressure can forward its state verbatim. `nominal` = no pressure.
 * @typedef {"nominal" | "fair" | "serious" | "critical"} PressureLevel
 */

/**
 * Tuning for memory-pressure detection. All optional — unset keys keep the defaults.
 * @typedef {Object} MemoryThresholds
 * @property {number} [fair]     used/budget ratio that reports `fair`. Default 0.7.
 * @property {number} [serious]  used/budget ratio that reports `serious`. Default 0.85.
 * @property {number} [critical] used/budget ratio that reports `critical`. Default 0.95.
 * @property {number} [wasmFloorFraction] WASM growth floor as a fraction of budget. Default 0.25.
 * @property {number} [wasmBurstFraction] WASM growth burst as a fraction of budget. Default 0.5.
 * @property {number} [gpuFloorFraction]  GPU activity floor as a fraction of budget. Default 0.25.
 * @property {number} [gpuBurstFraction]  GPU activity burst as a fraction of budget. Default 0.5.
 */

/**
 * Structured payload carried on a memory-pressure event (the `onMemoryPressure` arg + the recorded
 * `Warning.info`). All fields optional so a zero-arg `onMemoryPressure()` and a bare
 * `reportMemoryPressure()` both stay valid.
 * @typedef {Object} MemoryPressureInfo
 * @property {PressureLevel} [level]    Severity. Defaults to `serious` when not derivable.
 * @property {string} [source]          Who reported it ("performance.memory" | "wasm-growth" |
 *                                      "sampler" | "app").
 * @property {number} [usedBytes]       Current usage (sampler/app-reported).
 * @property {number} [limitBytes]      Effective budget the usage was compared against.
 * @property {number} [ratio]           usedBytes/limitBytes, if computable.
 * @property {number} [committedBytes]  WASM committed linear memory (growth detector).
 * @property {number | null} [budgetBytes] Resolved budget at detection time.
 * @property {number} [agentMemoryBytes]   measureUserAgentSpecificMemory() total, if available.
 */

/**
 * Public configuration. Defaults live in `src/index.js` (see DEFAULTS).
 * @typedef {Object} CrashboxOptions
 * @property {number} [heartbeatMs]        Heartbeat cadence, ms. Default 2000.
 * @property {number} [breadcrumbLimit]    Ring-buffer capacity. Default 100.
 * @property {number} [snapshotMaxBytes]   JSON byte cap for snapshots. Default 32768.
 * @property {DetectorName[]} [detectors]  Enabled detectors. Default ["js"].
 * @property {number} [retentionMs]        Sweep orphaned records older than this on init. Default 7d.
 * @property {string} [namespace]          Isolate co-hosted apps on a shared origin: keys become
 *                                         `crashbox:<namespace>:…`. No default (bare `crashbox:`).
 * @property {boolean} [debug]             Attach a `window.__crashbox` debug handle. Off by
 *                                         default — opt-in so the SDK never pollutes a host's
 *                                         namespace unless asked.
 * @property {number} [memoryBudgetBytes]  App-declared total memory budget (e.g. web-llm's
 *                                         `vram_required_MB * 1048576`). The denominator for
 *                                         pressure ratios and the scaler for the WASM/GPU
 *                                         thresholds; overrides the weaker auto-detected limits.
 * @property {number} [memorySampleMs]     `memory` detector cadence, ms. Default 2000.
 * @property {MemoryThresholds} [memoryThresholds] Override pressure cut-points / threshold fractions.
 * @property {() => (number | { usedBytes: number, limitBytes?: number } | null | undefined)} [getMemoryEstimate]
 *                                         Pull source polled on the heartbeat: return current used
 *                                         bytes (or a {usedBytes,limitBytes} pair), or null/undefined
 *                                         to skip. Must be cheap & synchronous. Compared against the
 *                                         budget to emit a leveled memory-pressure event.
 * @property {(record: CrashRecord) => void} [onCrashRecovered]
 * @property {(info?: MemoryPressureInfo) => void} [onMemoryPressure]
 * @property {(info: { reason?: string }) => void} [onDeviceLossImminent]
 */

/**
 * Fully-resolved options (defaults applied). Callbacks remain optional.
 * @typedef {Required<Pick<CrashboxOptions, "heartbeatMs" | "breadcrumbLimit" | "snapshotMaxBytes" | "detectors" | "retentionMs">> & CrashboxOptions} ResolvedOptions
 */

/**
 * One persisted session's black box (what's written to localStorage, keyed per session).
 * @typedef {Object} BlackBoxRecord
 * @property {string} sessionId
 * @property {Breadcrumb[]} breadcrumbs
 * @property {Snapshot | undefined} snapshot
 * @property {number} lastSeen           Epoch ms of the last heartbeat.
 * @property {boolean} cleanShutdown     True iff a pagehide{persisted:false} marker was written.
 */

/**
 * Signals captured at load that distinguish a crash from a discard / clean exit.
 * All optional — availability varies by browser.
 * @typedef {Object} LoadSignals
 * @property {boolean} wasDiscarded            `document.wasDiscarded` — iOS tab discard.
 * @property {string} [navigationType]         "navigate" | "reload" | "back_forward".
 * @property {boolean} cleanShutdown           A `pagehide{persisted:false}` marker was written.
 * @property {number | null} heartbeatAgeMs    Gap since the last heartbeat, or null.
 * @property {boolean} hasLiveSession          A prior session's snapshot/heartbeat exists.
 */

export {};
