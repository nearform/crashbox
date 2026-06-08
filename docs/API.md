# crashbox — API reference

Full reference for the public API, detectors, the debug handle, and platform caveats. For the
overview — what crashbox does, how it works, and what it patches — see the
[README](../README.md).

## API

### `init(options?)`

Recovers the previous session, then starts a fresh one (black box + heartbeat + clean-shutdown
marker + detectors). Idempotent. Options (all optional):

| option                 | default   | description                                                                                                                                                      |
| ---------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detectors`            | `["js"]`  | Which detectors to enable: `"js"`, `"webgpu"`, `"wasm"`, `"memory"`.                                                                                             |
| `heartbeatMs`          | `2000`    | Heartbeat cadence (ms). Also the `getMemoryEstimate` poll cadence.                                                                                               |
| `breadcrumbLimit`      | `100`     | Ring-buffer capacity (oldest dropped when full).                                                                                                                 |
| `snapshotMaxBytes`     | `32768`   | JSON byte cap for snapshots; oversized/cyclic snapshots are rejected.                                                                                            |
| `retentionMs`          | `7 days`  | Orphaned records older than this are swept on `init`.                                                                                                            |
| `namespace`            | —         | Isolate co-hosted apps on one origin: keys become `crashbox:<ns>:…`.                                                                                             |
| `debug`                | `false`   | Attach a `window.__crashbox` debug handle (see below).                                                                                                           |
| `memoryBudgetBytes`    | —         | App-declared memory budget. Denominator for pressure ratios + scales the WASM/GPU thresholds; overrides the weak auto-detected limits.                           |
| `memorySampleMs`       | `2000`    | `memory` detector poll cadence (ms).                                                                                                                             |
| `memoryThresholds`     | see below | Override pressure cut-points / threshold fractions.                                                                                                              |
| `getMemoryEstimate`    | —         | `() => number \| { usedBytes, limitBytes? } \| null` — cheap, sync pull source polled on the heartbeat; compared to the budget to emit a leveled pressure event. |
| `onCrashRecovered`     | —         | `(record) => void` — fired once on load if the prior session crashed.                                                                                            |
| `onMemoryPressure`     | —         | `(info?) => void` — memory pressure crossed a threshold. `info` is a `MemoryPressureInfo` (below); the zero-arg form stays valid.                                |
| `onDeviceLossImminent` | —         | `(info) => void` — a WebGPU OOM / oversized-buffer early warning.                                                                                                |

#### Memory-pressure detection

crashbox detects memory pressure as a **fraction of a budget**, not on fixed byte counts — so a
high-memory machine doesn't false-positive on routine allocations. Layered, best-signal-first:

1. **`memory` detector** (Chromium): polls `performance.memory` and reports a level when the
   `usedJSHeapSize / jsHeapSizeLimit` ratio crosses a threshold — the only _real_ pressure signal
   the platform offers. A no-op where `performance.memory` is absent (iOS Safari, Firefox).
2. **Budget-scaled `wasm`/`gpu` thresholds**: the growth thresholds become a fraction of the
   resolved budget. The budget is, in precedence order, `memoryBudgetBytes` →
   `performance.memory.jsHeapSizeLimit` → `navigator.deviceMemory`. With **no** signal (iOS Safari)
   the original fixed 64 MB/256 MB thresholds are kept — preserving the only indicator iOS has.
3. **App-supplied** (see [`getMemoryEstimate`](#init-options) and
   [`reportMemoryPressure`](#reportmemorypressureinfo)) — feed in what your app knows precisely.

Severity uses the [Compute Pressure API](https://developer.mozilla.org/en-US/docs/Web/API/Compute_Pressure_API)
vocabulary so an app already running a `PressureObserver` can forward `record.state` verbatim:

```ts
type PressureLevel = "nominal" | "fair" | "serious" | "critical";

type MemoryThresholds = {
  // used/budget ratios → level (defaults shown)
  fair?: number; // 0.7
  serious?: number; // 0.85
  critical?: number; // 0.95
  // growth thresholds as a fraction of budget (defaults shown)
  wasmFloorFraction?: number; // 0.25
  wasmBurstFraction?: number; // 0.5
  gpuFloorFraction?: number; // 0.25
  gpuBurstFraction?: number; // 0.5
};

type MemoryPressureInfo = {
  level?: PressureLevel; // defaults to "serious" when not derivable
  source?: string; // "performance.memory" | "wasm-growth" | "sampler" | "app"
  usedBytes?: number;
  limitBytes?: number;
  ratio?: number;
  committedBytes?: number; // WASM growth detector
  budgetBytes?: number | null;
  agentMemoryBytes?: number; // measureUserAgentSpecificMemory(), when available
};
```

Repeated pressure at the same level is de-duplicated (hysteresis): a level warns once on a rising
edge, re-fires only after ~30 s if it stays elevated, and re-arms when it drops back to `nominal`.

### `breadcrumb(msg, data?)`

Record a short breadcrumb. Cheap and persisted synchronously, so the last crumb before a hard kill
survives. `data` is an optional small JSON-safe object.

### `setSnapshot(state)`

Provide/replace the current state snapshot. JSON-serialized and size-capped before persist; an
un-serializable or oversized snapshot is rejected (the prior snapshot is kept) and the rejection is
breadcrumbed rather than thrown.

### `attachGPUDevice(device)`

Register a `GPUDevice` so the `webgpu` detector can wrap it. No-op unless `"webgpu"` is enabled.

### `reportMemoryPressure(info?)`

Report memory pressure your **app** computed itself — for spikes between heartbeat ticks that
`getMemoryEstimate` would miss (a caught OOM, an allocation failure, a runtime's own pressure
event). Flows into the same sinks as auto-detected pressure: records a live warning
(`getStatus().warnings`), drops a `memory-near-cap` breadcrumb (so a hard kill that follows recovers
as reason `oom`), and invokes `onMemoryPressure(info)` — all subject to the shared hysteresis. When
`usedBytes` is given without an explicit `level`, the level is derived from the budget/thresholds.
No-op before `init`.

```js
// e.g. an in-browser LLM that just caught an out-of-memory during generation
reportMemoryPressure({
  level: "critical",
  usedBytes: kvCache.bytes(),
  source: "app",
});
```

### `teardown()`

Fully unload crashbox — the inverse of `init`. **Reinstates every monkey-patched native method**
(`GPUDevice.createBuffer`, `GPUQueue.writeBuffer`, `GPUQueue.submit`,
`WebAssembly.Memory.prototype.grow`), removes the `error` / `unhandledrejection` /
`uncapturederror` / `pagehide` listeners, clears the heartbeat and detector timers, and deletes the
`window.__crashbox` debug handle — leaving the page as if crashbox had never loaded. It first marks
the current session as a clean shutdown (teardown is an intentional, graceful exit, like
`pagehide`), so the next load does **not** report it as a crash. Safe to call before `init` or more
than once. See [What this library patches](#what-this-library-patches).

### `clearRecovered()`

Clear the crash record delivered on this load. `init` delivers a recovered crash once (via
`onCrashRecovered`) and then retains it so the debug handle's `recovered()` can keep reporting it.
Once your app has acknowledged or dismissed the crash, call `clearRecovered()` so the debug handle
stops returning a stale record — keeping every consumer of "the crash this load" in sync with your
app's state. No-op if nothing was recovered.

### `getStatus()` / `getActiveOptions()`

Introspection. `getStatus()` → `{ sessionId, lastSeen, breadcrumbCount, warnings } | null`, where
`warnings` is the in-session ring buffer of `memory-pressure` / `device-loss-imminent` events (each
`{ t, kind, info? }`) — populated even when the app supplies no callbacks, so a UI can list
"warnings this session". `getActiveOptions()` → the resolved options or `null` before `init`.

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

- **`wasm`** — wraps `WebAssembly.Memory.prototype.grow` to track committed linear memory; when
  growth crosses the (budget-scaled) threshold it fires `onMemoryPressure` and breadcrumbs, so a
  WASM OOM recovers as `oom`. A failed grow (`RangeError`) is a `critical` signal, fired
  unconditionally. Catches JS-initiated growth (including emscripten's `_emscripten_resize_heap`).
- **`memory`** — polls `performance.memory` (Chromium only; a no-op elsewhere) and fires
  `onMemoryPressure(info)` with a `level` when the `usedJSHeapSize / jsHeapSizeLimit` ratio crosses a
  threshold. The budget-relative, _real_ pressure signal — pairs with `wasm`/`webgpu` (which see
  growth, not the system total). See [Memory-pressure detection](#memory-pressure-detection).

  ```js
  init({
    detectors: ["js", "wasm", "webgpu", "memory"],
    memoryBudgetBytes: modelVramBytes, // e.g. web-llm's vram_required_MB * 1048576
    onMemoryPressure: (info) => {
      if (info?.level === "critical") shedLoad();
    },
  });
  ```

## What this library patches

The detectors enrich the crash trail by **monkey-patching native methods in place** — they replace
a method with a wrapper that forwards to the saved original. Every wrap is reverted when the
detector is stopped (on re-`init`), and [`teardown()`](#teardown) reinstates **all** of them at once
— restoring the native methods so the page is left as if crashbox never loaded:

| Native API                                                                                                                                      | Detector | Why we patch it                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| [`GPUDevice.createBuffer`](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createBuffer)                                             | `webgpu` | Flag a buffer request larger than `limits.maxBufferSize` before it's allocated       |
| [`GPUQueue.writeBuffer`](https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/writeBuffer)                                                 | `webgpu` | Tally committed GPU bytes for the throttled activity log                             |
| [`GPUQueue.submit`](https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/submit)                                                           | `webgpu` | Count submits to annotate the activity breadcrumb                                    |
| [`WebAssembly.Memory.prototype.grow`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/Memory/grow) | `wasm`   | Track committed linear memory across instances (the only iOS memory-pressure signal) |

The first three are **per-instance** patches on the `GPUDevice`/`GPUQueue` you pass to
`attachGPUDevice`. The last is a **prototype** patch, so it affects every `WebAssembly.Memory` in
the realm while the `wasm` detector is active — which is why it's reverted on teardown.

Two things that are **not** monkey-patches:

- [`window.__crashbox`](https://developer.mozilla.org/en-US/docs/Web/API/Window) is a global handle
  _added_ only when `debug: true` (see [Debugging](#debugging)) — it augments the global namespace
  rather than overriding a native API. The SDK never touches `window` unless `debug` is set.
- The `error` / `unhandledrejection` / `uncapturederror` / `pagehide` listeners are ordinary
  `addEventListener` registrations (and are removed on teardown), not patches.

## Debugging

`init({ debug: true })` attaches `window.__crashbox` (handy in Safari devtools on a tethered phone):

- `__crashbox.dump()` — parsed contents of every `crashbox:*` localStorage key
- `__crashbox.recovered()` — the crash record recovered on this load (or `null`)
- `__crashbox.clearRecovered()` — clear that recovered record (after the app has handled it)
- `__crashbox.getStatus()` — the live session (incl. `warnings`)
- `__crashbox.reportMemoryPressure(info?)` — report app-computed pressure (see above)
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
- **Memory-pressure signal varies by platform.** There is no portable real-pressure API:
  `performance.memory` (the used/limit ratio the `memory` detector uses), `navigator.deviceMemory`,
  and `performance.measureUserAgentSpecificMemory()` are all **Chromium-only** — and absent on iOS
  Safari even when cross-origin-isolated. So on Chromium crashbox uses the budget-relative ratio;
  on iOS Safari it falls back to WASM/GPU growth tracking (the only leading indicator there). For a
  precise signal everywhere, supply `memoryBudgetBytes` and/or `getMemoryEstimate` /
  `reportMemoryPressure` from what your app knows ([research §6](./research/06-memory-pressure.md)).
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
