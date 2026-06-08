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

## Update — Chromium augmentation + budget-relative detection (implemented)

The original fixed thresholds (≥64 MB/2 s window, ≥256 MB burst) mean "a lot was allocated", not
"memory is under pressure" — so on a high-memory machine (e.g. a 128 GB Mac running web-llm) they
false-positive constantly. The detection is now **budget-relative and layered** (`src/detectors.js`,
`src/env.js`, `src/index.js`):

- **`performance.memory` ratio** (new `memory` detector, Chromium only): `usedJSHeapSize /
jsHeapSizeLimit` crossing a threshold → leveled `onMemoryPressure`. The only _real_ pressure proxy
  the platform offers. No-op where absent (iOS Safari, Firefox) — confirmed by the table above.
- **Budget-scaled WASM/GPU thresholds**: the growth thresholds become a fraction of a resolved
  budget (`memoryBudgetBytes` → `jsHeapSizeLimit` → `navigator.deviceMemory`). With no signal (iOS)
  the fixed bytes are kept — so the iOS behavior validated above is unchanged.
- **Severity vocabulary** aligned to the W3C Compute Pressure API (`nominal`/`fair`/`serious`/
  `critical`). Note: the Compute Pressure API itself has **no memory source** (CPU only), so it
  can't supply the signal — we only borrow its state names.
- **App-supplied** (`memoryBudgetBytes`, `getMemoryEstimate`, `reportMemoryPressure`) — the precise
  path everywhere, especially iOS Safari where no browser memory API exists.

### web-llm: what an in-browser LLM can hand crashbox

web-llm's `prebuiltAppConfig` model records carry exact memory facts (verified against the
[WebLLM API reference](https://webllm.mlc.ai/docs/) / `src/config.ts`):

- **`ModelRecord.vram_required_MB`** — the model's required VRAM. The precise static budget: pass
  `vram_required_MB * 1048576` as `memoryBudgetBytes`. (Unified memory on Apple Silicon ⇒ ≈ system
  memory too.)
- **`ModelRecord.buffer_size_required_bytes`** vs **`engine.getMaxStorageBufferBindingSize()`** — a
  pre-flight headroom check, especially on iOS Safari (which caps `maxStorageBufferBindingSize`
  lower than desktop) — a place crashbox otherwise has no signal.
- **`ModelRecord.low_resource_required`** — coarse device-tier hint; **`engine.getGPUVendor()`** —
  breadcrumb context; **`engine.runtimeStatsText()`** — a text blob (not a clean numeric source).
- **Caught OOM / load failure** — the between-tick spike that `reportMemoryPressure({level:
"critical"})` exists for.

Since weights dominate and load once, the high-value integration is the static budget (feeds
threshold-scaling) + the error-path `reportMemoryPressure`. A refined `getMemoryEstimate` can later
add a KV-cache estimate from `context_window_size`/tokens-in-context.

### On-device validation — iPhone 15 Pro / iOS Safari via the joyce app + web-llm, 2026-06-07

Wired into a real consumer (joyce: `detectors: ["js","webgpu","wasm","memory"]`, `memoryBudgetBytes`
from a device budget, `getMemoryEstimate` from web-llm load progress, `reportMemoryPressure` on the
load/generate error path) and exercised on real hardware. Device WebGPU limits read from the adapter:

```
maxStorageBufferBindingSize = maxBufferSize = 1,073,741,824  (exactly 1 GB)
navigator.deviceMemory = undefined   // confirms the iOS path → 1.5 GB constant budget
```

What the trails confirmed:

- **Budget-scaled WASM floor removes the false `oom`.** With a 1.5 GB budget the WASM floor scales
  `max(64 MB, 0.25 × 1.5 GB) ≈ 384 MB`, so the gte-small embeddings extractor (~100 MB committed)
  **no longer leaves a `memory-near-cap` crumb**. Before the fix that stray crumb made _any_ later
  unclean exit (e.g. a 5-min background discard) misclassify as `oom`; after, a clean small-model
  load carries no memory crumb at all. This is the iOS analogue of the 128 GB desktop false-positive.
- **`getMemoryEstimate` ratio → leveled warnings works as the iOS pressure signal.** With no
  `performance.memory`, the app-fed used/budget ratio is the only heap-like signal, and it escalated
  `fair (72%) → serious (88%) → critical (96%)` as committed memory climbed — then the tab OOM-killed
  and recovered as **`oom`** (was `hard-kill` without the signal, since nothing marked the cause).
- **`reportMemoryPressure` on load failure recovers as `oom`.** iOS surfaces a memory load failure as
  a generic `TypeError: Load failed` (not "out of memory"), so **message-matching is unreliable** —
  correlate the failure with the pre-flight verdict instead.
- **Budget 1.5 GB is well-calibrated.** `critical` (~0.95 → ~1.46 GB) lands just under the empirical
  ~1.5–2 GB hard-kill point (§2), so escalation completes before the kill. The 1 GB
  `maxStorageBufferBindingSize` makes the deterministic buffer-cap check a backstop (web-llm splits
  weights across sub-1 GB buffers); the vram-vs-budget ratio is the workhorse.
- **Cumulative footprint matters more than per-model.** A consumer that keeps multiple engines
  resident (no eviction) OOMs on the _sum_ of models that each fit alone (697 + 945 MB > 1.5 GB). The
  budget/estimate must therefore track the total across resident models, and a pre-flight must
  project the _full intended_ vram of in-flight models (not progress-weighted, or two near-concurrent
  loads each at ~0% project ~0). This accounting is the app's responsibility (it owns the budget +
  estimate); crashbox just levels whatever used/limit it's handed. A projected ratio ≥ 1.0 is treated
  as won't-fit → `critical`.
