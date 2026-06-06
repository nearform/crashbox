# crashbox — API reference

Full reference for the public API, detectors, the debug handle, and platform caveats. For the
overview — what crashbox does, how it works, and what it patches — see the
[README](../README.md).

## API

### `init(options?)`

Recovers the previous session, then starts a fresh one (black box + heartbeat + clean-shutdown
marker + detectors). Idempotent. Options (all optional):

| option                 | default  | description                                                            |
| ---------------------- | -------- | ---------------------------------------------------------------------- |
| `detectors`            | `["js"]` | Which detectors to enable: `"js"`, `"webgpu"`, `"wasm"`.               |
| `heartbeatMs`          | `2000`   | Heartbeat cadence (ms).                                                |
| `breadcrumbLimit`      | `100`    | Ring-buffer capacity (oldest dropped when full).                       |
| `snapshotMaxBytes`     | `32768`  | JSON byte cap for snapshots; oversized/cyclic snapshots are rejected.  |
| `retentionMs`          | `7 days` | Orphaned records older than this are swept on `init`.                  |
| `namespace`            | —        | Isolate co-hosted apps on one origin: keys become `crashbox:<ns>:…`.   |
| `debug`                | `false`  | Attach a `window.__crashbox` debug handle (see below).                 |
| `onCrashRecovered`     | —        | `(record) => void` — fired once on load if the prior session crashed.  |
| `onMemoryPressure`     | —        | `() => void` — WASM linear-memory growth crossed a pressure threshold. |
| `onDeviceLossImminent` | —        | `(info) => void` — a WebGPU OOM / oversized-buffer early warning.      |

### `breadcrumb(msg, data?)`

Record a short breadcrumb. Cheap and persisted synchronously, so the last crumb before a hard kill
survives. `data` is an optional small JSON-safe object.

### `setSnapshot(state)`

Provide/replace the current state snapshot. JSON-serialized and size-capped before persist; an
un-serializable or oversized snapshot is rejected (the prior snapshot is kept) and the rejection is
breadcrumbed rather than thrown.

### `attachGPUDevice(device)`

Register a `GPUDevice` so the `webgpu` detector can wrap it. No-op unless `"webgpu"` is enabled.

### `teardown()`

Fully unload crashbox — the inverse of `init`. **Reinstates every monkey-patched native method**
(`GPUDevice.createBuffer`, `GPUQueue.writeBuffer`, `GPUQueue.submit`,
`WebAssembly.Memory.prototype.grow`), removes the `error` / `unhandledrejection` /
`uncapturederror` / `pagehide` listeners, clears the heartbeat and detector timers, and deletes the
`window.__crashbox` debug handle — leaving the page as if crashbox had never loaded. It first marks
the current session as a clean shutdown (teardown is an intentional, graceful exit, like
`pagehide`), so the next load does **not** report it as a crash. Safe to call before `init` or more
than once. See [What this library patches](../README.md#what-this-library-patches).

### `clearRecovered()`

Clear the crash record delivered on this load. `init` delivers a recovered crash once (via
`onCrashRecovered`) and then retains it so the debug handle's `recovered()` can keep reporting it.
Once your app has acknowledged or dismissed the crash, call `clearRecovered()` so the debug handle
stops returning a stale record — keeping every consumer of "the crash this load" in sync with your
app's state. No-op if nothing was recovered.

### `getStatus()` / `getActiveOptions()`

Introspection. `getStatus()` → `{ sessionId, lastSeen, breadcrumbCount } | null`;
`getActiveOptions()` → the resolved options or `null` before `init`.

### `CrashRecord`

```ts
{
  sessionId: string;
  reason: "webgpu-device-lost" | "oom" | "hard-kill" | "unknown";
  lastSeen: number;            // epoch ms of the final heartbeat (≈ time of death)
  breadcrumbs: { t: number; msg: string; data?: object }[];
  snapshot: object | undefined;
}
```

## Detectors

Detectors are **enrichment**: they drop breadcrumbs and fire early-warning callbacks. The hard kill
itself is always caught by next-load inference, not by a live event.

- **`js`** (default) — `error` + `unhandledrejection` listeners, plus a main-thread watchdog
  (`setInterval` drift) for hang detection, since iOS Safari has no
  `PerformanceObserver('longtask')`. A `RangeError` surfaces as `oom`.
- **`webgpu`** — wraps a `GPUDevice` (via `attachGPUDevice`): distinguishes an intentional
  `device.lost` (`reason: "destroyed"`) from unexpected loss, surfaces `uncapturederror`
  (`GPUOutOfMemoryError` fires `onDeviceLossImminent`), flags oversized buffers, and keeps a
  throttled GPU-activity log so a committed GPU OOM (which fires no `device.lost`) still recovers as
  `webgpu-device-lost`.

  ```js
  init({
    detectors: ["webgpu", "js"],
    onDeviceLossImminent: () => checkpointAndShedLoad(),
  });
  const device = await adapter.requestDevice();
  attachGPUDevice(device);
  ```

- **`wasm`** — wraps `WebAssembly.Memory.prototype.grow` to track committed linear memory; under
  pressure it fires `onMemoryPressure` and breadcrumbs, so a WASM OOM recovers as `oom`. Catches
  JS-initiated growth (including emscripten's `_emscripten_resize_heap`).

## Debugging

`init({ debug: true })` attaches `window.__crashbox` (handy in Safari devtools on a tethered phone):

- `__crashbox.dump()` — parsed contents of every `crashbox:*` localStorage key
- `__crashbox.recovered()` — the crash record recovered on this load (or `null`)
- `__crashbox.clearRecovered()` — clear that recovered record (after the app has handled it)
- `__crashbox.getStatus()` — the live session
- `__crashbox.clear()` — wipe crashbox's storage (reset between tests)
- `__crashbox.teardown()` — fully unload crashbox (also removes this handle)

The SDK never touches `window` unless `debug` is set.

## Platform notes & caveats

The platform behavior below was tested on real iOS 18.7 / Safari 26.3 (iPhone 15 Pro); the empirical
log is in [`docs/research/`](./research/).

- **Hard kills are inferred after the fact, not caught live.** That's the whole design — there is no
  event at the moment of death. You get the record on the _next_ load.
- **Pure-JS allocation rarely hard-kills on iOS.** iOS Safari throws a catchable
  `RangeError: Out of memory` for JS-heap / bare `Memory.grow` floods rather than killing the tab.
  The real tab kills come from _committed_ native memory — GPU buffers written via `writeBuffer`,
  touched WASM pages, LLM weights — which is what crashbox targets. The committed WASM and GPU OOM
  paths both hard-killed around **~1.5–2 GB** on the test device, a shared per-tab budget
  ([research §2](./research/02-ios-discard-vs-crash.md) / [§3](./research/03-webgpu-device-loss.md)).
- **No false positives on backgrounding.** App-switch and BFCache tab-switch are distinguished from
  crashes and produce no `CrashRecord` (device-confirmed). An iOS tab-discard is suppressed via
  `document.wasDiscarded` (unit-tested; iOS resisted reproducing a real discard on the test device,
  so this suppressor is logic-validated, not yet field-observed —
  [research §2](./research/02-ios-discard-vs-crash.md)).
- **The reason is inferred, not confirmed.** The Reporting API `crash` report that could
  corroborate it is Chromium-only and server-bound (a crashed page can't read it in JS), so
  ingesting it is deferred to a future version — see
  [`docs/work/FUTURE_WORK.md`](./work/FUTURE_WORK.md). The v1 heuristic stands on its own.
- **Known limitations (v1):** co-hosted apps on one origin should pass distinct `namespace`s so
  they don't share keys; **multiple tabs of the _same_ app** still share keys and can interfere
  with each other's recovery; `onCrashRecovered` is fire-once; pure module-internal `memory.grow` /
  engine-internal GPU growth bypass the JS hooks and aren't tracked. See
  [`docs/work/FUTURE_WORK.md`](./work/FUTURE_WORK.md).
