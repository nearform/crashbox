# `crashbox`

Local-first crash black box for the browser: survives hard tab kills (WebGPU,
WASM, in-browser OOM) and surfaces the recovered state on next load.

When a browser tab dies hard — a WebGPU device/process kill, a WASM or in-browser
out-of-memory, an unresponsive-tab kill — no JavaScript runs at the moment of death.
This makes information recovery about the crash difficult. While there are some
browser-native crash reports (e.g. Chrome Reporting API `crash` report), this library
aims to work in any browser and application environment (from desktop to mobile).
And calling out a primary motivation, **iOS Safari**, is particularly challenging
where WebGPU/WASM workloads can take down the whole tab.

crashbox takes the only approach that works when you can't run code during the crash:

> Continuously persist a tiny "black box" (recent breadcrumbs + a state snapshot + a heartbeat) to
> storage that survives the renderer dying, write a **clean-shutdown marker** on graceful exit, and
> on the **next load** decide: _snapshot present + no clean-shutdown marker = the previous session
> crashed_ — then infer **why** from the breadcrumb trail and hand the app a `CrashRecord`.

- **Zero runtime dependencies.** Plain JS (with shipped TypeScript types). Drop-in.
- **iOS-first.** Validated on real iOS 18.7 / Safari 26.3 hardware.
- **Allocation-light.** The instrumentation must not cause the crash it's trying to catch.

## Install

```sh
$ npm install crashbox
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

`init(options?)`, `breadcrumb(msg, data?)`, `setSnapshot(state)`, `attachGPUDevice(device)`, and
`teardown()` (plus `clearRecovered()` to drop the recovered record once handled, and `getStatus()` /
`getActiveOptions()` for introspection). Three detectors —
`js` (default), `webgpu`, `wasm` — enrich the breadcrumb trail; they are **enrichment only**, since
the hard kill itself is always caught by next-load inference, never a live event. Shipped TypeScript
types describe every option and the recovered `CrashRecord`.

**→ Full reference** — every option, the `CrashRecord` shape, detector details, the debug handle,
and platform caveats — **lives in [docs/API.md](./docs/API.md).**

## What this library patches

The detectors enrich the crash trail by **monkey-patching native methods in place** — they
replace a method with a wrapper that forwards to the saved original. Every wrap is reverted when
the detector is stopped (on re-`init`), and [`teardown()`](./docs/API.md#teardown) reinstates **all**
of them at once — restoring the native methods so the page is left as if crashbox never loaded:

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
  _added_ only when `debug: true` (see [Debugging](./docs/API.md#debugging)) — it augments the global namespace
  rather than overriding a native API. The SDK never touches `window` unless `debug` is set.
- The `error` / `unhandledrejection` / `uncapturederror` / `pagehide` listeners are ordinary
  `addEventListener` registrations (and are removed on teardown), not patches.

## Caveats

A few things to know up front (the full list, with device-tested detail, is in
[docs/API.md](./docs/API.md#platform-notes--caveats)):

- **Hard kills are inferred after the fact, not caught live** — you get the record on the _next_ load.
- **The reason is a heuristic, not confirmed**
- **Multiple tabs of the _same_ app share keys** and can interfere with each other's recovery; give
  co-hosted apps on one origin distinct `namespace`s.

## Browser support

Any browser with `localStorage` and `pagehide`. Primary target and validation: **iOS Safari**.
The `webgpu`/`wasm` detectors require those APIs (the `js` detector and core recovery work
everywhere). Imported in a non-browser context (SSR/Node), `init` degrades to an in-memory no-op
rather than throwing.

## Contributing

Source is plain JS with JSDoc types; `npm run check` runs lint + type-check + tests + format.
Architecture and the empirical research log are in [`docs/`](./docs/); contributor notes are in
[`AGENTS.md`](./AGENTS.md).

## License

MIT
