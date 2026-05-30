# `crashbox`

Local-first crash black box for the browser: survives hard tab kills (WebGPU,
WASM, in-browser OOM) and surfaces the recovered state on next load.

When a browser tab dies hard — a WebGPU device/process kill, a WASM or in-browser
out-of-memory, an unresponsive-tab kill — **no JavaScript runs at the moment of death.** JS error
monitors (Sentry, Bugsnag) catch exceptions and unhandled rejections, but a hard tab kill fires no
event for them to catch. The one browser-native crash report — the Reporting API's `crash` report —
is Chromium-only, delivered to a **server** endpoint, and can't be read in JS at all (the page has
already crashed). None of that helps on the primary target, **iOS Safari**, where WebGPU/WASM
workloads can take down the whole tab.

crashbox takes the only approach that works when you can't run code during the crash:

> Continuously persist a tiny "black box" (recent breadcrumbs + a state snapshot + a heartbeat) to
> storage that survives the renderer dying, write a **clean-shutdown marker** on graceful exit, and
> on the **next load** decide: _snapshot present + no clean-shutdown marker = the previous session
> crashed_ — then infer **why** from the breadcrumb trail and hand the app a `CrashRecord`.

- **Zero runtime dependencies.** Plain JS (with shipped TypeScript types). Drop-in.
- **iOS-first.** Validated on real iOS 18.7 / Safari 26.3 hardware.
- **Allocation-light.** The instrumentation must not cause the crash it's trying to catch.

> **v1 scope:** localStorage-backed, 100% local (no backend). Detectors for `js`, `webgpu`, and
> `wasm` are implemented and device-validated. Deferred items (Reporting API corroboration, etc.)
> are in [`docs/FUTURE_WORK.md`](./docs/FUTURE_WORK.md).

## Install

```sh
npm install crashbox
```

## Quick start

Call `init` **as early as possible** — it recovers the previous session synchronously, so a crash
from the last load is delivered to `onCrashRecovered` before your app renders.

```js
import { init, breadcrumb, setSnapshot } from "crashbox";

init({
  detectors: ["js", "webgpu", "wasm"],
  onCrashRecovered(record) {
    // The previous session crashed. `record` has the inferred reason, the breadcrumb
    // tail, your last snapshot, and the estimated time of death.
    if (record.reason === "webgpu-device-lost") showRecoveryBanner(record);
    else console.warn("crashbox recovered a crash:", record);
  },
});

// Drop breadcrumbs at meaningful moments (cheap; persisted synchronously).
breadcrumb("started inference", { model: "llama-3.2-1b" });

// Replace the current state snapshot whenever it changes (JSON-serialized + size-capped).
setSnapshot({ route: "/chat", tokensGenerated: 128 });
```

That's the whole integration. crashbox handles the heartbeat, the clean-shutdown marker, and
recover-on-load for you.

## How it works

1. **Black box (durable write path).** A fixed-capacity breadcrumb ring buffer + your latest
   snapshot + a `lastSeen` heartbeat are written to `localStorage` on a throttled cadence. The write
   is synchronous, and a synchronous `localStorage` write survives the renderer being killed —
   verified on a real iOS OOM kill ([research §1](./docs/research/01-localstorage-durability.md)).
2. **Clean-shutdown marker.** On `pagehide` with `persisted: false` (the reliable graceful-exit
   signal — _not_ `beforeunload`/`unload`, which are unreliable on mobile), crashbox writes a
   "clean" flag.
3. **Recover on next load.** `init` reads the previous session and classifies it:
   - `document.wasDiscarded` → an iOS tab **discard**, suppressed (never a crash);
   - clean-shutdown marker present → a graceful **clean** exit;
   - a live session with neither → a **crash** → `onCrashRecovered(record)`.
4. **Reason inference.** On a crash, the cause is read from the **breadcrumb tail** (a hard kill
   has no live event to catch), producing one of:

   | `reason`             | meaning                                                  |
   | -------------------- | -------------------------------------------------------- |
   | `webgpu-device-lost` | WebGPU device loss / GPU-process OOM                     |
   | `oom`                | WASM / memory exhaustion (`RangeError`, near-cap growth) |
   | `hard-kill`          | died with a heartbeat trail but no attributable cause    |
   | `unknown`            | nothing to go on                                         |

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
  corroborated: boolean;       // true only if a Reporting API report confirmed the reason
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
  crashbox.attachGPUDevice(device);
  ```

- **`wasm`** — wraps `WebAssembly.Memory.prototype.grow` to track committed linear memory; under
  pressure it fires `onMemoryPressure` and breadcrumbs, so a WASM OOM recovers as `oom`. Catches
  JS-initiated growth (including emscripten's `_emscripten_resize_heap`).

## Debugging

`init({ debug: true })` attaches `window.__crashbox` (handy in Safari devtools on a tethered phone):

- `__crashbox.dump()` — parsed contents of every `crashbox:*` localStorage key
- `__crashbox.recovered()` — the crash record recovered on this load (or `null`)
- `__crashbox.getStatus()` — the live session
- `__crashbox.clear()` — wipe crashbox's storage (reset between tests)

The SDK never touches `window` unless `debug` is set.

## Platform notes & caveats

The platform behavior below was tested on real iOS 18.7 / Safari 26.3 (iPhone 15 Pro); the empirical
log is in [`docs/research/`](./docs/research/).

- **Hard kills are inferred after the fact, not caught live.** That's the whole design — there is no
  event at the moment of death. You get the record on the _next_ load.
- **Pure-JS allocation rarely hard-kills on iOS.** iOS Safari throws a catchable
  `RangeError: Out of memory` for JS-heap / bare `Memory.grow` floods rather than killing the tab.
  The real tab kills come from _committed_ native memory — GPU buffers written via `writeBuffer`,
  touched WASM pages, LLM weights — which is what crashbox targets. The committed WASM and GPU OOM
  paths both hard-killed around **~1.5–2 GB** on the test device, a shared per-tab budget
  ([research §2](./docs/research/02-ios-discard-vs-crash.md) / [§3](./docs/research/03-webgpu-device-loss.md)).
- **No false positives on backgrounding.** App-switch and BFCache tab-switch are distinguished from
  crashes and produce no `CrashRecord` (device-confirmed). An iOS tab-discard is suppressed via
  `document.wasDiscarded` (unit-tested; iOS resisted reproducing a real discard on the test device,
  so this suppressor is logic-validated, not yet field-observed —
  [research §2](./docs/research/02-ios-discard-vs-crash.md)).
- **`corroborated` is always `false` in v1.** The Reporting API `crash` report that could confirm a
  reason is Chromium-only and server-bound (a crashed page can't read it in JS), so ingesting it is
  deferred — see [`docs/FUTURE_WORK.md`](./docs/FUTURE_WORK.md). The heuristic stands on its own.
- **Known limitations (v1):** co-hosted apps on one origin should pass distinct `namespace`s so
  they don't share keys; **multiple tabs of the _same_ app** still share keys and can interfere
  with each other's recovery; `onCrashRecovered` is fire-once; pure module-internal `memory.grow` /
  engine-internal GPU growth bypass the JS hooks and aren't tracked. See
  [`docs/FUTURE_WORK.md`](./docs/FUTURE_WORK.md).

## Browser support

Any browser with `localStorage` and `pagehide`. Primary target and validation: **iOS Safari**.
The `webgpu`/`wasm` detectors require those APIs (the `js` detector and core recovery work
everywhere). Imported in a non-browser context (SSR/Node), `init` degrades to an in-memory no-op
rather than throwing.

## Contributing

Architecture, the spec, and the empirical research log live in [`docs/`](./docs/);
agent/contributor notes are in [`AGENTS.md`](./AGENTS.md). Source is plain JS with JSDoc types;
`npm run check` runs lint + type-check + tests + format.

## License

MIT
