// crashbox public API + browser wiring (localStorage-only, no ports/adapters/IDB). The spine:
// persist a tiny black box on a throttled cadence + a heartbeat, write a clean-shutdown marker on
// graceful exit, and on the next load decide "snapshot present + no clean-shutdown marker = the
// previous session crashed" via the pure helpers in ./blackbox.js + ./inference.js. Detectors
// (./detectors.js) enrich the trail. All browser access is guarded so importing/`init`-ing in
// Node or SSR is a safe no-op (degrades to in-memory, no persistence/recover) rather than throwing.

import { RingBuffer, serializeSnapshot, parseSnapshot } from "./blackbox.js";
import { classifyLoad, classifyReason } from "./inference.js";
import { enableDetectors } from "./detectors.js";
import { attachDebugHandle, detachDebugHandle } from "./debug.js";
import {
  getStorage,
  getWindow,
  getWasDiscarded,
  getNavType,
  makeSessionId,
  jsonSafe,
  unref,
} from "./env.js";

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
 * Default options:
 * - `heartbeatMs` 2000 — persist cadence.
 * - `breadcrumbLimit` 100 — ring-buffer capacity.
 * - `snapshotMaxBytes` 32768 — JSON snapshot byte cap.
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
 * localStorage). Set in `init`.
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

// --- persistence ------------------------------------------------------------

/** Synchronously mirror the current recorder to localStorage so the last write survives a hard kill. */
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
  unref(heartbeatId);
};

/**
 * `pagehide` with `persisted:false` is the reliable clean-exit signal (preferred over the
 * unreliable `beforeunload`/`unload`). `persisted:true` means bfcache (may return) → not a clean
 * shutdown. https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event
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
 * record is consumed (cleared) either way — fire-once delivery.
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
  try {
    detectorHandles = enableDetectors({ breadcrumb, options: active });
  } catch {
    detectorHandles = []; // a detector failing to attach must not break init
  }

  // 5. Opt-in debug handle (never touches window unless asked).
  if (active.debug) {
    attachDebugHandle({
      api: {
        init,
        teardown,
        breadcrumb,
        setSnapshot,
        attachGPUDevice,
        getActiveOptions,
        getStatus,
      },
      getKeyPrefix: () => keyPrefix,
      getRecovered: () => lastRecovered,
    });
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
 * @returns {{ sessionId: string, lastSeen: number, breadcrumbCount: number } | null}
 */
export const getStatus = () =>
  recorder
    ? {
        sessionId: recorder.sessionId,
        lastSeen: recorder.lastSeen,
        breadcrumbCount: recorder.ring.size,
      }
    : null;
