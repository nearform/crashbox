# crashbox 💥

Local-first crash black box for the browser: survives hard tab kills (WebGPU,
WASM, in-browser OOM) and surfaces the recovered state on next load.

When a browser tab dies hard (from a WebGPU device/process kill, a WASM or in-browser
out-of-memory, an unresponsive-tab kill, etc.) no JavaScript runs at the moment of death.
This makes information recovery about the crash difficult. While there are some
browser-native crash reports (e.g. Chrome Reporting API `crash` report), this library
aims to work in any browser and application environment (from desktop to mobile).
And calling out a primary motivation, **iOS Safari**, is particularly challenging
where WebGPU/WASM workloads can take down the whole tab.

crashbox takes the only approach that works when you can't run code during the crash:
continuously persisting a tiny "black box" (recent breadcrumbs + a state snapshot + a heartbeat) to
storage that survives the renderer dying, writing a **clean-shutdown marker** on graceful exit, and
on the **next load** deciding what happened with a breadcrumb trail and structured data the app
can ingest and review on next load.

Some nice things about this library:

- **Zero runtime dependencies.** Plain JS (with shipped TypeScript types). Drop-in.
- **iOS-friendly.** Validated on real iOS 18.7 / Safari 26.3 hardware.
- **Allocation-light.** The instrumentation must not cause the crash it's trying to catch.

## Install

```sh
$ npm install crashbox
```

## Quick start

Call `init` **as early as possible**, so that it may recover the previous session synchronously via `onCrashRecovered` before your app renders.

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

The black box (a breadcrumb ring buffer + your snapshot + a
`lastSeen` heartbeat) is written to `localStorage` synchronously, which survives the renderer being
killed, verified on a real iOS OOM kill ([research §1](./docs/research/01-localstorage-durability.md)).
A clean-shutdown marker is written only on `pagehide` with `persisted: false` (the one reliable
graceful-exit signal and _not_ `beforeunload`/`unload`). On the next load `init` classifies the
previous session: `document.wasDiscarded` → an iOS tab discard (suppressed), marker present → a
clean exit, neither → a **crash**, whose cause is read from the breadcrumb tail (a hard kill has no
live event):

| `reason`             | meaning                                                  |
| -------------------- | -------------------------------------------------------- |
| `webgpu-device-lost` | WebGPU device loss / GPU-process OOM                     |
| `oom`                | WASM / memory exhaustion (`RangeError`, near-cap growth) |
| `hard-kill`          | died with a heartbeat trail but no attributable cause    |
| `unknown`            | nothing to go on                                         |

## API

`init(options?)`, `breadcrumb(msg, data?)`, `wrap(name, fn, makeData?)` (breadcrumb an async
operation's start/ok/error), `setSnapshot(state)`, `attachGPUDevice(device)`,
`reportMemoryPressure(info?)` (report app-computed pressure), and `teardown()`
(plus `clearRecovered()` to drop the recovered record once handled, and `getStatus()` /
`getActiveOptions()` for introspection. Note that `getStatus()` also returns a `warnings` array of
in-session memory-pressure / device-loss events). Four detectors:
`js` (default), `webgpu`, `wasm`, and `memory` enrich the breadcrumb trail; they are **enrichment
only**, since the hard kill itself is always caught by next-load inference, never a live event.
Shipped TypeScript types describe every option and the recovered `CrashRecord`.

**Memory pressure is detected relative to a budget**, not on fixed byte counts — so a high-memory
machine doesn't false-positive. On Chromium the `memory` detector reads the `performance.memory`
used/limit ratio; the `wasm`/`webgpu` growth thresholds scale to a budget
(`memoryBudgetBytes` → `jsHeapSizeLimit` → `navigator.deviceMemory`); on iOS Safari (no memory API)
it falls back to growth tracking. Apps can feed in precise facts via `memoryBudgetBytes`,
`getMemoryEstimate`, or `reportMemoryPressure`. Severity uses the Compute Pressure vocabulary
(`nominal`/`fair`/`serious`/`critical`). See [docs/API.md](./docs/API.md#memory-pressure-detection).

See the full API docs in [docs/API.md](./docs/API.md) for more.

## What this library patches

The `webgpu` and `wasm` detectors enrich the crash trail by **monkey-patching native methods in
place** (e.g. `GPUDevice.createBuffer`, `WebAssembly.Memory.prototype.grow`). Each forwards to the
saved original, is reverted when the detector stops, and all are reinstated at once by
[`teardown()`](./docs/API.md#teardown), leaving the page as if crashbox never loaded. The `js`
detector's event listeners and the `debug` handle are **not** patches.

**Full list of what's patched, per-instance vs. prototype, and why →
[docs/API.md](./docs/API.md#what-this-library-patches).**

## Caveats

A few things to know up front (the full list, with device-tested detail, is in
[docs/API.md](./docs/API.md#platform-notes--caveats)):

- **Hard kills are inferred after the fact, not caught live.** You get the record on the _next_ load.
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
See [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) for the full dev workflow, releasing, and how to
add a changeset for your change. Architecture and the empirical research log are in
[`docs/`](./docs/); contributor notes are in [`AGENTS.md`](./AGENTS.md).

## License

MIT
