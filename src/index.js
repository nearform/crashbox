// crashbox public API (SPEC §5) + browser wiring (lean v1 — localStorage only, no
// ports/adapters/IDB). The spine (research §2 / SPEC §2): persist a tiny black box on a
// throttled cadence + a heartbeat, write a clean-shutdown marker on graceful exit, and on the
// next load decide "snapshot present + no clean-shutdown marker = the previous session crashed"
// via the pure helpers in ./blackbox.js + ./inference.js. Detectors (./detectors.js) are wired
// in Phase 3+. All browser access is guarded so importing/`init`-ing in Node or SSR is a safe
// no-op (degrades to in-memory, no persistence/recover) rather than throwing.

import { RingBuffer, serializeSnapshot, parseSnapshot } from "./blackbox.js";
import { classifyLoad, classifyReason } from "./inference.js";
import { enableDetectors } from "./detectors.js";

/** @typedef {import("./types.js").CrashboxOptions} CrashboxOptions */
/** @typedef {import("./types.js").CrashRecord} CrashRecord */
/** @typedef {import("./types.js").Snapshot} Snapshot */
/** @typedef {import("./types.js").ResolvedOptions} ResolvedOptions */
/** @typedef {import("./types.js").BlackBoxRecord} BlackBoxRecord */
/** @typedef {import("./types.js").LoadSignals} LoadSignals */

/**
 * Live recording state for the current session (in-memory; mirrored to localStorage).
 * @typedef {Object} Recorder
 * @property {string} sessionId
 * @property {RingBuffer} ring
 * @property {Snapshot | undefined} snapshot
 * @property {number} lastSeen
 * @property {boolean} cleanShutdown
 */

/**
 * Default options. Values chosen from the research spikes:
 * - `heartbeatMs` 2000 — SPEC default cadence.
 * - `breadcrumbLimit` 100 — SPEC default; trivially within the ~38 GB iOS quota (research §6/#9).
 * - `snapshotMaxBytes` 32768 — JSON snapshot cap; sub-50µs to serialize at this size (research §8 #7).
 * - `detectors` ["js"] — JS detector default-on; webgpu/wasm are opt-in.
 * - `retentionMs` 7 days — orphaned records (e.g. from a tab that never reopened) older than this
 *   are swept on init. `namespace` has no default — unset means the bare `crashbox:` prefix.
 * @type {ResolvedOptions}
 */
export const DEFAULTS = {
  heartbeatMs: 2000,
  breadcrumbLimit: 100,
  snapshotMaxBytes: 32768,
  detectors: ["js"],
  retentionMs: 7 * 24 * 60 * 60 * 1000,
};

/**
 * localStorage key prefix. Bare `crashbox` by default; `crashbox:<namespace>` when
 * `options.namespace` is set, so two apps sharing one origin don't collide (origin-shared
 * localStorage). Set in `init`. (Same-app multi-tab keying is deferred — see docs/FUTURE_WORK.md.)
 */
const DEFAULT_PREFIX = "crashbox";
let keyPrefix = DEFAULT_PREFIX;
/** Points at the most recent session id, so the next load knows what to recover. */
const currentKey = () => `${keyPrefix}:current`;
const recordKeyPrefix = () => `${keyPrefix}:record:`;
/** @param {string} id */
const recordKey = (id) => `${recordKeyPrefix()}${id}`;

/** @type {ResolvedOptions | null} */
let active = null;
/** @type {Recorder | null} */
let recorder = null;
/** The crash record (if any) delivered on this load — exposed via the debug handle. */
/** @type {CrashRecord | null} */
let lastRecovered = null;
/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatId = null;
/** @type {import("./detectors.js").Detector[]} */
let detectorHandles = [];
let lifecycleAttached = false;

/**
 * In-session warning ring buffer — every `onMemoryPressure` / `onDeviceLossImminent` call is
 * mirrored here so a UI can list "warnings this session" without having to also subscribe to the
 * callbacks. Reset on every `init`. Cap matches `breadcrumbLimit` semantics — newest-N kept.
 * @typedef {{ t: number, kind: "memory-pressure" | "device-loss-imminent", info?: Record<string, unknown> }} Warning
 */
const WARNINGS_CAP = 50;
/** @type {Warning[]} */
let warnings = [];
const pushWarning = (/** @type {Warning} */ w) => {
  warnings.push(w);
  if (warnings.length > WARNINGS_CAP) {
    warnings.splice(0, warnings.length - WARNINGS_CAP);
  }
};

// --- guarded environment access (so init is safe in Node/SSR) --------------

/** @returns {Storage | null} */
const getStorage = () => {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null; // access can throw under some privacy modes
  }
};

/** @returns {Window | null} */
const getWindow = () => {
  try {
    return typeof window !== "undefined" ? window : null;
  } catch {
    return null;
  }
};

const getWasDiscarded = () => {
  try {
    // `document.wasDiscarded` is experimental (iOS tab-discard flag) and absent from lib.dom.
    return (
      typeof document !== "undefined" &&
      /** @type {any} */ (document).wasDiscarded === true
    );
  } catch {
    return false;
  }
};

/** @returns {string | undefined} */
const getNavType = () => {
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

const makeSessionId = () => {
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
const jsonSafe = (data) => {
  try {
    JSON.stringify(data);
    return data;
  } catch {
    return { "[unserializable]": true };
  }
};

// --- persistence ------------------------------------------------------------

/** Synchronously mirror the current recorder to localStorage (research §8 #1: survives OOM). */
const persist = () => {
  const storage = getStorage();
  if (!storage || !recorder) {
    return;
  }
  /** @type {BlackBoxRecord} */
  const record = {
    sessionId: recorder.sessionId,
    breadcrumbs: recorder.ring.toArray(),
    snapshot: recorder.snapshot,
    lastSeen: recorder.lastSeen,
    cleanShutdown: recorder.cleanShutdown,
  };
  try {
    storage.setItem(recordKey(recorder.sessionId), JSON.stringify(record));
  } catch {
    // quota / serialization failure — drop this write; in-memory state stays intact.
  }
};

/**
 * @param {Storage} storage
 * @param {string} id
 * @returns {BlackBoxRecord | undefined}
 */
const readRecord = (storage, id) => {
  try {
    const raw = storage.getItem(recordKey(id));
    return /** @type {BlackBoxRecord | undefined} */ (parseSnapshot(raw));
  } catch {
    return undefined; // getItem can throw under privacy modes
  }
};

// --- lifecycle --------------------------------------------------------------

const stopHeartbeat = () => {
  if (heartbeatId !== null) {
    clearInterval(heartbeatId);
    heartbeatId = null;
  }
};

const stopDetectors = () => {
  for (const d of detectorHandles) {
    try {
      d.stop();
    } catch {
      // a detector's teardown must not break init/re-init
    }
  }
  detectorHandles = [];
};

const startHeartbeat = () => {
  stopHeartbeat();
  if (!active || active.heartbeatMs <= 0) {
    return;
  }
  heartbeatId = setInterval(() => {
    if (recorder) {
      recorder.lastSeen = Date.now();
      persist();
    }
  }, active.heartbeatMs);
  // Don't keep a Node test process alive on the timer (no-op in the browser).
  /** @type {any} */ (heartbeatId)?.unref?.();
};

/**
 * `pagehide` with `persisted:false` is the reliable clean-exit signal (SPEC §3/§4; NOT
 * `beforeunload`/`unload`). `persisted:true` means bfcache (may return) → not a clean shutdown.
 * @param {PageTransitionEvent} e
 */
const onPageHide = (e) => {
  if (recorder && e && e.persisted === false) {
    recorder.cleanShutdown = true;
    persist();
    stopHeartbeat();
  }
};

const attachLifecycle = () => {
  if (lifecycleAttached) {
    return;
  }
  const win = getWindow();
  if (!win) {
    return;
  }
  try {
    win.addEventListener("pagehide", /** @type {EventListener} */ (onPageHide));
    lifecycleAttached = true;
  } catch {
    // no addEventListener — degrade to no clean-shutdown marker (still recovers as crash).
  }
};

/** Remove the `pagehide` listener attached by `attachLifecycle` (teardown). */
const detachLifecycle = () => {
  if (!lifecycleAttached) {
    return;
  }
  const win = getWindow();
  if (win) {
    try {
      win.removeEventListener(
        "pagehide",
        /** @type {EventListener} */ (onPageHide),
      );
    } catch {
      // best-effort detach
    }
  }
  lifecycleAttached = false;
};

// --- recover-on-load --------------------------------------------------------

/**
 * Build the discard-vs-crash signals for a recovered previous session.
 * @param {BlackBoxRecord} prev
 * @returns {LoadSignals}
 */
const buildSignals = (prev) => ({
  wasDiscarded: getWasDiscarded(),
  navigationType: getNavType(),
  cleanShutdown: prev.cleanShutdown === true,
  heartbeatAgeMs:
    typeof prev.lastSeen === "number" ? Date.now() - prev.lastSeen : null,
  hasLiveSession: true,
});

/**
 * Read the previous session, classify it, and return a CrashRecord iff it crashed. The previous
 * record is consumed (cleared) either way — fire-once delivery (SPEC §0 retention question).
 * @returns {CrashRecord | null}
 */
const recoverPrevious = () => {
  const storage = getStorage();
  if (!storage) {
    return null;
  }
  let prevId;
  try {
    prevId = storage.getItem(currentKey());
  } catch {
    return null;
  }
  if (!prevId) {
    return null;
  }
  const prev = readRecord(storage, prevId);
  if (!prev) {
    return null;
  }

  const signals = buildSignals(prev);
  const load = classifyLoad(signals);
  const breadcrumbs = prev.breadcrumbs || [];

  /** @type {CrashRecord | null} */
  let recovered = null;
  if (load === "crash") {
    recovered = {
      sessionId: prev.sessionId,
      reason: classifyReason({ breadcrumbs, signals }),
      lastSeen: prev.lastSeen,
      breadcrumbs,
      snapshot: prev.snapshot,
      corroborated: false, // Reporting API corroboration deferred — see docs/FUTURE_WORK.md
    };
  }

  // Consume the previous session regardless of outcome.
  try {
    storage.removeItem(recordKey(prevId));
  } catch {
    // best-effort cleanup
  }
  return recovered;
};

/**
 * Sweep orphaned records (e.g. from a tab that crashed and never reopened, so its record was never
 * consumed) older than `retentionMs`. Bounds localStorage growth. Best-effort; runs on init.
 */
const sweepStaleRecords = () => {
  const storage = getStorage();
  const ttl = active ? active.retentionMs : 0;
  if (!storage || !(ttl > 0)) {
    return;
  }
  const now = Date.now();
  const prefix = recordKeyPrefix();
  /** @type {string[]} */
  const stale = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(prefix)) {
        continue;
      }
      const rec = /** @type {any} */ (parseSnapshot(storage.getItem(k)));
      const lastSeen =
        rec && typeof rec.lastSeen === "number" ? rec.lastSeen : 0;
      if (now - lastSeen > ttl) {
        stale.push(k); // collect first — removing mid-iteration shifts indices
      }
    }
    for (const k of stale) {
      storage.removeItem(k);
    }
  } catch {
    // best-effort sweep
  }
};

// --- debug handle (opt-in via options.debug) --------------------------------

/** Every `crashbox:*` key currently in localStorage. @returns {string[]} */
const debugKeys = () => {
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
 */
const attachDebugHandle = () => {
  const win = getWindow();
  if (!win) {
    return;
  }
  // GLOBAL AUGMENTATION (not a method wrap): add a `__crashbox` property to the global `window`.
  // Unlike the detector monkey-patches, this doesn't override an existing native API — it pollutes
  // the global namespace with a new handle, and only ever when `options.debug` is set.
  // https://developer.mozilla.org/en-US/docs/Web/API/Window
  /** @type {any} */ (win).__crashbox = {
    init,
    teardown,
    breadcrumb,
    setSnapshot,
    attachGPUDevice,
    getActiveOptions,
    getStatus,
    /** The crash record recovered on this load, or null. */
    recovered: () => lastRecovered,
    /** Parsed contents of every `crashbox:*` localStorage key. */
    dump: () => {
      const storage = getStorage();
      /** @type {Record<string, unknown>} */
      const out = {};
      if (storage) {
        for (const k of debugKeys()) {
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
      const keys = debugKeys();
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
const detachDebugHandle = () => {
  const win = getWindow();
  if (win && /** @type {any} */ (win).__crashbox) {
    try {
      delete (/** @type {any} */ (win).__crashbox);
    } catch {
      /** @type {any} */ (win).__crashbox = undefined; // non-configurable — null it out instead
    }
  }
};

// --- public API -------------------------------------------------------------

/**
 * Initialize crashbox: recover the previous session (delivering a crash via `onCrashRecovered`),
 * then start a fresh session — black box + heartbeat + clean-shutdown marker. Idempotent: a
 * second call tears down the prior session's timer and starts anew.
 * @param {CrashboxOptions} [options]
 * @returns {void}
 */
export const init = (options = {}) => {
  active = { ...DEFAULTS, ...options };
  keyPrefix = active.namespace
    ? `${DEFAULT_PREFIX}:${active.namespace}`
    : DEFAULT_PREFIX;
  stopHeartbeat();
  stopDetectors();
  warnings = [];

  // 1. Recover the previous session before we overwrite the "current" pointer, then sweep
  //    orphaned records (from tabs that never reopened) past the retention window.
  const recovered = recoverPrevious();
  lastRecovered = recovered;
  sweepStaleRecords();
  if (recovered && active.onCrashRecovered) {
    try {
      active.onCrashRecovered(recovered);
    } catch {
      // a throwing app callback must not break init
    }
  }

  // 2. Start a fresh session and make it the current black box.
  recorder = {
    sessionId: makeSessionId(),
    ring: new RingBuffer(active.breadcrumbLimit),
    snapshot: undefined,
    lastSeen: Date.now(),
    cleanShutdown: false,
  };
  persist();
  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(currentKey(), recorder.sessionId);
    } catch {
      // non-persistent mode — recording still works in-memory
    }
  }

  // 3. Heartbeat + clean-shutdown marker.
  startHeartbeat();
  attachLifecycle();

  // 4. Detectors enrich the trail (js default-on; webgpu/wasm opt-in). They emit breadcrumbs
  //    via the public recorder, so a caught error/stall/OOM-pressure signal shows up in the
  //    next load's crash record and feeds classifyReason.
  //    Warning callbacks are wrapped so every fire is also recorded in the live `warnings`
  //    buffer (queryable via getStatus()), with the user's original callback invoked after.
  //    `active` itself is left unmodified so getActiveOptions() returns what the user passed.
  const userMemoryPressure = active.onMemoryPressure;
  const userDeviceLossImminent = active.onDeviceLossImminent;
  /** @type {ResolvedOptions} */
  const detectorOptions = {
    ...active,
    onMemoryPressure: () => {
      pushWarning({ t: Date.now(), kind: "memory-pressure" });
      if (userMemoryPressure) {
        try {
          userMemoryPressure();
        } catch {
          // a throwing app callback must not break the detector
        }
      }
    },
    onDeviceLossImminent: (info) => {
      pushWarning({
        t: Date.now(),
        kind: "device-loss-imminent",
        info: info ? { ...info } : undefined,
      });
      if (userDeviceLossImminent) {
        try {
          userDeviceLossImminent(info);
        } catch {
          // a throwing app callback must not break the detector
        }
      }
    },
  };
  try {
    detectorHandles = enableDetectors({ breadcrumb, options: detectorOptions });
  } catch {
    detectorHandles = []; // a detector failing to attach must not break init
  }

  // 5. Opt-in debug handle (never touches window unless asked).
  if (active.debug) {
    attachDebugHandle();
  }
};

/**
 * Record a breadcrumb. Cheap: allocates only the entry; persisted synchronously so the last
 * crumb before a hard kill survives. No-op before `init`.
 * @param {string} msg
 * @param {Record<string, unknown>} [data]
 * @returns {void}
 */
export const breadcrumb = (msg, data) => {
  if (!recorder) {
    return;
  }
  recorder.ring.push({
    t: Date.now(),
    msg: String(msg),
    ...(data !== undefined ? { data: jsonSafe(data) } : {}),
  });
  persist();
};

/**
 * Provide/replace the current state snapshot (JSON-serialized + size-capped before persist).
 * An un-serializable or oversized snapshot is rejected (the prior snapshot is kept) and the
 * rejection is breadcrumbed rather than thrown into the app. No-op before `init`.
 * @param {Snapshot} state
 * @returns {void}
 */
export const setSnapshot = (state) => {
  if (!recorder || !active) {
    return;
  }
  const json = serializeSnapshot(state, active.snapshotMaxBytes);
  if (json === null) {
    recorder.ring.push({
      t: Date.now(),
      msg: "crashbox: snapshot rejected (cyclic or over snapshotMaxBytes)",
      data: { signal: "snapshot-rejected" },
    });
    persist();
    return;
  }
  // Store a detached JSON clone so later app-side mutation doesn't leak into the box.
  recorder.snapshot = parseSnapshot(json);
  persist();
};

/**
 * Register a WebGPU device so the detector can wrap it (`device.lost` / `uncapturederror` /
 * oversized-buffer early warning). No-op unless the `webgpu` detector is enabled.
 * @param {GPUDevice} device
 * @returns {void}
 */
export const attachGPUDevice = (device) => {
  for (const d of detectorHandles) {
    if (d.attachGPUDevice) {
      d.attachGPUDevice(device);
    }
  }
};

/**
 * Fully unload crashbox, reinstating the original native objects/functions — the inverse of
 * `init`. Restores every monkey-patched method (`GPUDevice.createBuffer`, `GPUQueue.writeBuffer`,
 * `GPUQueue.submit`, `WebAssembly.Memory.prototype.grow`) via the detectors' own teardown, removes
 * the `error`/`unhandledrejection`/`uncapturederror`/`pagehide` listeners, clears the heartbeat and
 * detector timers, and deletes the `window.__crashbox` debug handle — leaving the page as if
 * crashbox had never loaded. Marks the current session as a clean shutdown first (teardown is an
 * intentional, graceful exit, like `pagehide`), so the next load does NOT report it as a crash.
 * Safe to call before `init` or more than once (idempotent no-op).
 * @returns {void}
 */
export const teardown = () => {
  // 1. Graceful-exit marker: teardown is intentional, so mark the session clean (same as the
  //    pagehide path) BEFORE dropping the listener — otherwise the next load misreads the still-
  //    live box as a crash. Persist while keyPrefix still points at this session's keys.
  if (recorder) {
    recorder.cleanShutdown = true;
    persist();
  }
  // 2. Stop our timers, then restore every monkey-patched native method and remove the detector
  //    listeners (each detector's stop() reinstates the originals it wrapped).
  stopHeartbeat();
  stopDetectors();
  // 3. Remove crashbox's own listener + global handle so nothing of ours stays attached to the page.
  detachLifecycle();
  detachDebugHandle();
  // 4. Reset module state back to pre-init.
  active = null;
  recorder = null;
  lastRecovered = null;
  keyPrefix = DEFAULT_PREFIX;
};

/**
 * The active resolved options, or null before `init`. Exposed for tests/introspection.
 * @returns {ResolvedOptions | null}
 */
export const getActiveOptions = () => active;

/**
 * Live status of the current session, or null before `init`. Introspection for the demo /
 * on-device debugging (lets a tester correlate which session id later shows up as a crash).
 * `warnings` is the in-session ring buffer of `onMemoryPressure` / `onDeviceLossImminent` events
 * — populated by the SDK even when the app didn't supply callbacks.
 * @returns {{ sessionId: string, lastSeen: number, breadcrumbCount: number, warnings: Warning[] } | null}
 */
export const getStatus = () =>
  recorder
    ? {
        sessionId: recorder.sessionId,
        lastSeen: recorder.lastSeen,
        breadcrumbCount: recorder.ring.size,
        warnings: [...warnings],
      }
    : null;

/**
 * Wrap an async operation: breadcrumb `<name>:start`, then either `<name>:ok` (with duration)
 * on success or `<name>:error` (with duration, error name, and truncated message) on throw.
 * Re-throws errors so caller semantics are unchanged. No-op-safe before `init` (breadcrumb
 * silently drops).
 * @template T
 * @param {string} name
 * @param {() => Promise<T> | T} fn
 * @param {() => Record<string, unknown>} [makeData] Lazy: only called if a breadcrumb fires.
 * @returns {Promise<T>}
 */
export const wrap = async (name, fn, makeData) => {
  breadcrumb(`${name}:start`, makeData ? makeData() : undefined);
  const t0 = Date.now();
  try {
    const result = await fn();
    breadcrumb(`${name}:ok`, { ms: Date.now() - t0 });
    return result;
  } catch (err) {
    const e = /** @type {any} */ (err);
    breadcrumb(`${name}:error`, {
      ms: Date.now() - t0,
      name: e?.name,
      message: String(e?.message ?? e).slice(0, 200),
    });
    throw err;
  }
};
