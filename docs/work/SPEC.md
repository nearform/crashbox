# crashbox — design & specification

The design rationale behind crashbox: the problem it solves, the one insight the whole library
turns on, and how the pieces fit. For the usage-facing reference (every option, the `CrashRecord`
shape, detectors, caveats) see [API.md](../API.md); for the empirical findings the design rests on
see [docs/research/](../research/).

crashbox is a single, **zero-runtime-dependency** package, plain JavaScript with JSDoc type
annotations (no transpile step; `tsc --checkJs` type-checks and emits `.d.ts`). MIT licensed.

## 1. Problem

When a browser tab dies hard — WebGPU device loss / GPU-process kill, WASM out-of-memory, or an
in-browser LLM exhausting memory — no JavaScript runs at the moment of death. Existing tools
(Sentry, Bugsnag) catch JS exceptions and unhandled rejections but **not** hard tab crashes, and the
only browser-native crash signal (the Reporting API `crash` report) is Chromium-only, server-bound,
and carries almost no debug detail. None of this helps on the primary target: **iOS Safari**, where
WebGPU/WASM workloads can kill the whole tab and there is no Reporting API, no extensions, and
unreliable unload events.

crashbox is a **drop-in JS SDK** that:

1. Continuously persists a tiny "black box" (recent breadcrumbs + current state snapshot) to storage
   that survives the renderer process dying.
2. On the **next load**, infers whether the previous session crashed and why, and surfaces the
   recovered record to the embedding app.
3. Where possible, fires **early-warning** callbacks (memory pressure, imminent device loss) so the
   app can checkpoint or shed load _before_ death.

**Non-goals:** no server backend (data stays 100% local; an upload hook may come later — see
[FUTURE_WORK.md](./FUTURE_WORK.md)); not a frame-level GPU debugger; and it cannot recover a crash
_in progress_ — the renderer is gone. The guarantee is that the last-known-good state was durably
written _before_ the crash, and the picture is reconstructed after.

## 2. Core insight

**You cannot run code during a hard crash.** The entire design reduces to:

> Persist a small state snapshot to durable storage on a throttled cadence, write a "clean shutdown"
> marker on graceful exit, and on the next load decide: _snapshot present + no clean-shutdown marker
> = the previous session crashed._

Everything else (detectors, reason inference, early warning) is enrichment on top of that spine.
Two hard constraints fall out of it:

- **The instrumentation must not cause the crash it's trying to catch.** Sentry historically grew
  memory until the browser died while collecting error data. The hot path must allocate almost
  nothing and writes must be throttled/coalesced.
- **The black box must stay tiny** (KB, not MB) to survive storage quota pressure and eviction.

## 3. Architecture

Three layers.

### Layer 1 — The black box (durable write path)

The store is **`localStorage`**: a synchronous write is flushed before the next line executes, and a
real iOS OOM kill confirmed the last sync write survives with zero tail loss while the box stays
KB-sized ([research §1](../research/01-localstorage-durability.md)). IndexedDB (the originally
planned richer store) is unnecessary at this size and is deferred ([FUTURE_WORK.md](./FUTURE_WORK.md)).

- **Black box contents:** a fixed-capacity breadcrumb ring buffer + the latest state snapshot,
  keyed by `sessionId`.
- **Heartbeat:** write a `lastSeen` timestamp every N seconds (default ~2s) so the next session can
  estimate time-of-death.
- **Write policy:** coalesce breadcrumbs; cap the snapshot to low-tens-of-KB JSON; drop oldest
  breadcrumbs when the ring is full.
- Keys are namespaced `crashbox:<ns>:…` so co-hosted apps on one origin don't collide (the
  `namespace` option). Same-app multi-tab is a known limitation ([FUTURE_WORK.md](./FUTURE_WORK.md)).

### Layer 2 — Detectors (opt-in, enrichment only)

Detectors drop breadcrumbs and fire early-warning callbacks; they never catch the hard kill itself
(there is no live event at the moment of death — Layer 3 does that). Three are available:

- **`webgpu`** — wraps a `GPUDevice`: distinguishes intentional `device.lost`
  (`reason: "destroyed"`) from unexpected loss, surfaces `uncapturederror`
  (`GPUOutOfMemoryError` → `onDeviceLossImminent`), flags oversized buffers, and keeps a throttled
  GPU-activity log so a committed GPU OOM (which fires no `device.lost`) still recovers as
  `webgpu-device-lost` ([research §3](../research/03-webgpu-device-loss.md)).
- **`wasm`** — wraps `WebAssembly.Memory.prototype.grow` to track committed linear memory; fires
  `onMemoryPressure` under load. The sole memory signal on iOS, which has no memory-measurement API
  ([research §6](../research/06-memory-pressure.md)).
- **`js`** (default) — `error` / `unhandledrejection` listeners plus a main-thread watchdog
  (`setInterval` drift), since iOS Safari has no `PerformanceObserver('longtask')`.

### Layer 3 — Crash inference (runs on next load)

On graceful exit, write a **clean-shutdown marker** — only on `pagehide` with `persisted === false`,
the one reliable teardown signal. _Not_ `beforeunload`/`unload` (unreliable on mobile), nor
`visibilitychange:hidden` or `pagehide{persisted:true}` (both recoverable, not exits)
([research §2](../research/02-ios-discard-vs-crash.md)). On startup, classify the previous session:

- `document.wasDiscarded === true` → an iOS tab **discard**, suppressed (a crash never sets this);
- clean-shutdown marker present → a graceful **clean** exit;
- a live session with neither → a **crash** → infer the reason from the breadcrumb tail.

**Reason precedence:** `webgpu-device-lost` → `oom` → `hard-kill` → `unknown`.

## 4. iOS Safari realities

- No Reporting API, no extensions, flaky `unload`. The design leans on `pagehide{persisted:false}` +
  the synchronous `localStorage` heartbeat.
- iOS aggressively **discards** backgrounded / memory-heavy tabs and silently reloads them — which
  looks identical to a crash unless suppressed via `document.wasDiscarded`. This is the most
  important false-positive guard.
- **Pure-JS allocation rarely hard-kills** — iOS throws a catchable `RangeError` instead. Real tab
  kills come from _committed_ native memory (touched WASM pages, GPU buffers written via
  `writeBuffer`, LLM weights), which hit a shared ~1.5–2 GB per-tab budget on the test device.
- Storage quota is ample (~38 GB); eviction under pressure, not quota, is the constraint — keep the
  box minimal.

## 5. Public API

The full reference — every `init` option, the `CrashRecord` shape, the detectors, the debug handle,
and platform caveats — lives in **[API.md](../API.md)**. In brief: `init(options?)` recovers the
previous session and starts a fresh one; `breadcrumb(msg, data?)` and `setSnapshot(state)` feed the
black box; `attachGPUDevice(device)` registers a device for the `webgpu` detector; `teardown()`
fully unloads. Recovered crashes arrive via the `onCrashRecovered(record)` callback.

## 6. Package layout

One zero-dependency package. The pure logic lives in two dependency-free modules unit-tested
directly under `node --test`; `index.js` does the browser wiring; `detectors.js` holds the opt-in
wrappers. There is no build-time transpile — `tsc --checkJs --noEmit` type-checks and a separate
`tsc` run emits `dist/*.d.ts` for TypeScript consumers.

```
crashbox/
  src/
    index.js        # public API + browser wiring: localStorage black box, heartbeat,
                    #   pagehide{persisted:false} clean-shutdown marker, recover-on-load
    types.js        # JSDoc @typedef hub (CrashRecord, Breadcrumb, CrashboxOptions, …)
    blackbox.js     # PURE: ring buffer (allocation-light) + JSON snapshot serialize/size-cap
    inference.js    # PURE: classifyLoad (discard-vs-crash guard) + classifyReason
    detectors.js    # opt-in source wrappers: js / webgpu / wasm
    debug.js        # window.__crashbox handle (only when debug: true)
  test/             # node --test; pure modules tested directly, browser fakes (happy-dom) only here
  docs/             # this design doc + API reference + research findings (not published)
  index.html        # demo / integration harness (imports ./src/index.js, no build step)
```

`blackbox.js` + `inference.js` are pure (plain data in/out) and unit-tested with no dependency
injection; the `index.js` / `detectors.js` browser wiring is validated via the demo and real iOS
hardware.

## Design decisions

A few choices worth recording, with the reasoning:

- **Single package, not a monorepo.** The "layers" are internal `src/` modules with conceptually
  tree-shakeable detectors, not separate packages.
- **`localStorage`-only.** A synchronous write survives a real iOS OOM with zero loss and the box is
  KB-sized, so IndexedDB is deferred.
- **JSON snapshot contract.** `setSnapshot` JSON-serializes defensively; a cyclic or oversized
  snapshot is rejected (the prior snapshot kept) and breadcrumbed rather than thrown. `localStorage`
  can only carry strings, so `structuredClone`'s extra fidelity can't survive the path anyway, and
  JSON is both cheaper and more portable ([research §7](../research/07-snapshot-serialization.md)).
- **Heartbeat staleness is binary.** Any recorded heartbeat is enough to call a no-cause crash a
  `hard-kill`; a crash auto-reloads fast, so a short gap doesn't rule one out
  ([research §2](../research/02-ios-discard-vs-crash.md)).
- **`onCrashRecovered` is fire-once;** the record is consumed during `init`. Deferred-delete/ack is
  a possible hardening ([FUTURE_WORK.md](./FUTURE_WORK.md)).
- **Retention.** A `retentionMs` sweep evicts orphaned records on `init`.
