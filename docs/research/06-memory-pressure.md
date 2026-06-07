# Research 06 — Memory-pressure leading indicators (+ #9 storage budget)

> **Status: iOS done.** No memory API exists on iOS Safari, so `onMemoryPressure` must rely on
> WASM-growth tracking; storage quota is ample (~38 GB). The wasm detector (`src/detectors.js`)
> wraps `WebAssembly.Memory.prototype.grow`, tracks total committed linear memory, and fires
> `onMemoryPressure` + `memory-near-cap` breadcrumbs under pressure (≥256 MB burst flushes
> immediately, else ≥64 MB / 2 s window). Catches JS-initiated grows incl. emscripten's
> `_emscripten_resize_heap`; pure module-internal `memory.grow` is not caught (future: poll exported
> memories' `byteLength`).

## Question

Which memory-pressure early-warning signals exist on iOS Safari (`performance.memory`,
`navigator.deviceMemory`, `measureUserAgentSpecificMemory`), and what storage quota does
`navigator.storage.estimate()` report — to set the black-box size budget and the `onMemoryPressure`
trigger.

## Method

Spike page: [`spikes/capabilities-probe.html`](./spikes/capabilities-probe.html). Loads instantly and
dumps a capability/quota report. Copy the box.

> **Serve over HTTPS for trustworthy numbers.** `navigator.storage.estimate()` (StorageManager),
> `measureUserAgentSpecificMemory()`, and `crossOriginIsolated` are secure-context-gated — over a
> plain `http://<lan-ip>` origin they read unsupported/0. Use `ngrok http 8080`. The plain booleans
> (WebGPU/WASM/`wasDiscarded`/longtask presence) are valid over HTTP.

## Environments to cover

- [x] iOS Safari (iPhone 15 Pro) — **iOS 18.7, Safari 26.3**, over HTTPS (`crossOriginIsolated: true`)

## Results

### iOS Safari 26.3 / iOS 18.7 (iPhone 15 Pro), 2026-05-29 — HTTPS / cross-origin-isolated

```json
{
  "navigator.deviceMemory": "unsupported",
  "navigator.hardwareConcurrency": 4,
  "performance.memory": "unsupported",
  "crossOriginIsolated": true,
  "measureUserAgentSpecificMemory present": false,
  "storageEstimate": { "quota_MB": 39322, "usage_MB": 310 },
  "persisted": false,
  "navigator.gpu (WebGPU)": true,
  "WebAssembly": true,
  "PerformanceObserver longtask": false,
  "ReportingObserver": true
}
```

- **No memory-measurement API on iOS Safari.** `deviceMemory` and `performance.memory` are absent,
  and `measureUserAgentSpecificMemory()` is **not implemented even though `crossOriginIsolated` is
  true**. There is no browser signal for memory pressure.
- **`PerformanceObserver` does not support `longtask`** on iOS Safari → the spec's long-task/hang JS
  detector is unavailable on the primary target.
- **Storage quota ≈ 38 GB** (usage 310 MB) — quota is not the constraint; eviction under pressure is.
- WebGPU and WebAssembly present; `hardwareConcurrency: 4`; `ReportingObserver` exists (but crash-
  report _delivery_ is the Chromium-only question — #5).

## Decision this drives

- **`onMemoryPressure` on iOS = WASM linear-memory growth tracking only** (no browser memory API
  exists; `measureUserAgentSpecificMemory` is absent even when isolated). The WASM detector is the
  sole leading indicator on the primary target; on Chromium, `measureUserAgentSpecificMemory` /
  `performance.memory` can augment it.
- **Hang detection cannot use `PerformanceObserver('longtask')` on iOS** — the JS detector needs a
  main-thread watchdog (e.g. `setInterval`/`rAF` gap detection) instead.
- **Snapshot/breadcrumb caps are bounded by eviction risk and hot-path cost, not quota** (~38 GB
  available). Keep the ~16–32 KB serialization budget from [07](./07-snapshot-serialization.md);
  consider `navigator.storage.persist()` to reduce eviction (currently `persisted: false`).
