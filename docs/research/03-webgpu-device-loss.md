# Research 03 — WebGPU device-loss taxonomy (+ #4 GPU-kill-takes-tab)

> SPEC §8 #3 and #4. Status: **iOS done (both)** — full taxonomy on iPhone 15 Pro: graceful destroy,
> oversized buffer, lazy alloc, and a **real VRAM-commit OOM that hard-killed the tab with no
> `device.lost`** (#4 answered). WebGPU is the **primary v1 detector target**. The implemented
> detector (`src/detectors.js`) was device-validated 2026-05-29 — see
> [Follow-up](#follow-up-2026-05-29--crashbox-webgpu-detector-on-device-phase-5).

## Question

Catalog `GPUDevice.lost` `reason`/`message` and `uncapturederror` behavior on iOS Safari 26+: which
losses leave the tab **alive** (catchable by the WebGPU detector) vs. take the **whole tab** down
(inference-only, Layer 3). Plus the adapter limits that set the SDK's oversized-buffer early-warning
threshold.

## Method

Spike page: [`spikes/webgpu-device-loss.html`](./spikes/webgpu-device-loss.html). On load it probes
`navigator.gpu` → adapter → device, records `adapter.limits`, and attaches `device.lost` +
`uncapturederror`. Buttons, in order:

1. **`device.destroy()`** — graceful loss; expect `device.lost` `reason:"destroyed"`, tab survives.
2. **Oversized buffer** — `createBuffer` at 1.5× / 4× / 64× `maxBufferSize`; capture validation /
   out-of-memory errors and whether the device is lost.
3. **Buffer-alloc flood** — allocate large buffers in a loop; watch for `device.lost` vs. a tab kill
   (the §8 #4 GPU-process-kill-takes-tab case). The page persists its event log to localStorage, so a
   tab death is visible in the "previousLoad" field after reload.

Run on the iPhone 15 Pro; copy the "SUMMARY" box after each step.

> **Requires a secure context.** `navigator.gpu` is `undefined` on an insecure origin, so this page
> must be served over **HTTPS** (e.g. `ngrok http 8080`) — a plain `http://<lan-ip>` origin will
> falsely report no WebGPU.

## Environments to cover

- [x] iOS Safari (iPhone 15 Pro) — **iOS 18.7, Safari 26.3**, HTTPS — probe + destroy + oversized + flood done
- [ ] Desktop Chrome (CDP) — for cross-reference

## Results

### iOS Safari 26.3 / iOS 18.7 (iPhone 15 Pro), 2026-05-29

**Initial probe (on load):** WebGPU is available and a device was acquired.

```json
{
  "gpuPresent": true,
  "adapter": {
    "info": {},
    "features": ["…compression, shader-f16, timestamp-query, etc."]
  },
  "limits": {
    "maxBufferSize": 1073741824,
    "maxStorageBufferBindingSize": 1073741824,
    "maxComputeWorkgroupsPerDimension": 65535
  },
  "events": ["device-acquired"]
}
```

- **WebGPU works on iOS 18.7 / Safari 26.3** — `navigator.gpu` resolves an adapter + device.
- **`maxBufferSize` = 1 GiB** (= `maxStorageBufferBindingSize`). This is the threshold the
  oversized-buffer early-warning keys off.
- **`adapter.info` is `{}`** — Safari privacy-gates it; no vendor/architecture/device strings, so the
  detector can't fingerprint or branch on GPU identity on iOS.

**1 · `device.destroy()` (graceful):** `deviceLost: {reason: "destroyed", message: ""}`; events
`device-acquired → calling-destroy → device.lost:destroyed`; **tab survives.**

→ The catchable happy path works: `device.lost` resolves with `reason:"destroyed"` on intentional
teardown. The detector keys on `reason === "destroyed"` to tell intentional loss from a crash. (The
empty `message` carries no extra info on iOS.)

**2 · oversized buffer (1.5× / 4× / 64× `maxBufferSize`):** events
`buffer x1.5:created → uncapturederror:GPUValidationError → buffer x4:created → buffer x64:created`;
**`deviceLost: null` — device survives all three.**

→ An over-limit `createBuffer` **does not throw synchronously and does not lose the device**. It
returns an error-buffer and emits a **`GPUValidationError`** (size > `maxBufferSize` is _validation_,
not OOM — so an `out-of-memory` error scope does **not** catch it; it propagates to
`uncapturederror`). Detector implications: (a) wrap `createBuffer` and **compare requested size to
`maxBufferSize` proactively**; (b) **listen on `uncapturederror` for `GPUValidationError`**; (c) don't
expect a throw or a device-loss signal from over-limit allocations. This is the limit case, not real
VRAM exhaustion (see flood, next).

**3 · buffer-alloc flood:** allocated **> 5 TB** of nominal buffers (256 MB × thousands) with **no
device loss and no tab death**; a single `uncapturederror: GPUOutOfMemoryError` surfaced early
(~4 GB) but `createBuffer` kept returning indefinitely. Had to reload to stop the loop.

→ **`createBuffer` is lazy on iOS Safari — GPU memory isn't committed until a buffer is actually used
(written/bound/dispatched).** Allocation alone cannot exhaust the GPU or trigger device loss, and the
detector's early-warning **cannot wait for `createBuffer` to fail**.

**4 · committed flood — real VRAM (§8 #4, the GPU-kill case):** uploaded 128 MB into each buffer via
`queue.writeBuffer` (one reused CPU source). The **tab was OOM-killed** after ~162 GB of queued
uploads. Recovered `previousLoad` trail:

```
device-acquired → commit-flood-start → uncapturederror:GPUOutOfMemoryError
→ commit:512MB → … → commit:162304MB → [tab dies]
```

- **No `device.lost` event before death** — a real GPU/unified-memory OOM **takes the whole tab down
  with no graceful loss event**, exactly like the WASM OOM. This is **Layer-3 inference territory**
  (snapshot present + no clean-shutdown marker), not something the WebGPU detector can catch live.
- **But there is an early-warning window:** a single **`uncapturederror: GPUOutOfMemoryError` fired
  seconds before death** (at the first over-budget commit), well ahead of the kill. That is the
  actionable signal for `onDeviceLossImminent` — the app gets time to checkpoint/shed load.
- (The ~162 GB nominal figure reflects `writeBuffer` copies queued faster than they commit on
  unified memory; the point is the tab died and no loss event fired.)

### Follow-up 2026-05-29 — crashbox webgpu detector on-device (Phase 5)

Validated the implemented detector (`src/detectors.js`) end-to-end against the demo on the same
device:

- **Graceful `device.destroy()`** → breadcrumbed as intentional (`reason:"destroyed"`, no loss
  marker); tab survives. ✅
- **Oversized buffer (2× `maxBufferSize`)** → proactive size warning + `onDeviceLossImminent` + a
  `GPUValidationError` via `uncapturederror`; none mis-tagged as a crash. ✅
- **Committed `writeBuffer` flood** → tab hard-killed; recovered next load as
  **`reason:"webgpu-device-lost"`**. ✅

Two refinements to the findings above:

- **Unified ~1.5–2 GB tab ceiling.** The committed flood died right after a ~1536 MB milestone — the
  _same_ window as the in-tab WASM OOM (research §2 follow-up). GPU-committed and WASM-linear memory
  share one per-tab budget; the "GPU OOM and WASM OOM converge" point is now numeric.
- **No live early-warning in the committed path.** Trigger → ~1536 MB spanned only ~200 ms; the tab
  died sub-second and **no `GPUOutOfMemoryError`/`uncapturederror` and no `onDeviceLossImminent`
  fired** before death (vs. the ~4 GB warning in the _lazy_ `createBuffer` flood at step 3/4). So
  `onDeviceLossImminent` is **not guaranteed** for a real committed GPU OOM — **Layer-3 inference is
  the load-bearing path**, and the next-load reason resolves to `webgpu-device-lost` only if a webgpu
  marker is in the breadcrumb trail.
  - **Gap exposed → FIXED (Phase 5.1).** In the original run the marker came from the _demo's_ own
    `gpu committed ~N MB` milestones; the detector only breadcrumbed loss / error / oversized events,
    not routine GPU activity, so a real app hit by a sub-second committed OOM with no `uncapturederror`
    would have recovered as `hard-kill`. The webgpu detector now keeps a **throttled rolling
    GPU-activity log**: it wraps `queue.writeBuffer`/`queue.submit` and breadcrumbs
    `webgpu activity: ~N MB committed` (tagged `webgpu-device-lost`) only under real memory pressure —
    a single ≥256 MB burst flushes immediately, otherwise ≥64 MB committed per 2 s window — so routine
    light GPU use stays out of the trail and can't hijack an unrelated crash's reason. The demo's
    commit-flood no longer breadcrumbs by hand; the marker now comes from the detector itself.

## Synthesized findings (iOS 18.7 / Safari 26.3) → detector design

| Trigger                            | `device.lost`        | tab      | how it surfaces                                         |
| ---------------------------------- | -------------------- | -------- | ------------------------------------------------------- |
| `device.destroy()`                 | `reason:"destroyed"` | alive    | `device.lost` resolves (catchable)                      |
| buffer > `maxBufferSize`           | none                 | alive    | `GPUValidationError` via `uncapturederror`              |
| createBuffer flood (no usage)      | none                 | alive    | one `GPUOutOfMemoryError`; lazy, no commit              |
| **real VRAM commit (writeBuffer)** | **none**             | **dies** | early `GPUOutOfMemoryError`, then hard tab kill (§8 #4) |

**`src/detectors/webgpu.js`:**

- Treat `device.lost` `reason === "destroyed"` as intentional (not a crash); any other reason =
  unexpected loss → crash breadcrumb. **Note: a real GPU OOM does NOT fire `device.lost` at all** — it
  hard-kills the tab, so the crash itself is caught by Layer-3 inference, not the detector.
- Early-warning (`onDeviceLossImminent`): fire on **`uncapturederror` of type `GPUOutOfMemoryError`**
  (it precedes the kill by seconds — the real actionable signal) and/or **proactively compare
  requested buffer sizes to `maxBufferSize`**. Do **not** rely on `createBuffer` throwing or on a
  device-loss event. **Caveat (Phase 5 device test):** in the _committed_ `writeBuffer` path the kill
  was sub-second and `GPUOutOfMemoryError` never fired — the early-warning window is not guaranteed;
  see the [Follow-up](#follow-up-2026-05-29--crashbox-webgpu-detector-on-device-phase-5).
- `adapter.info` is `{}` on iOS → no GPU fingerprint; don't branch on it.
- **GPU OOM and WASM OOM converge:** both take the tab with no live event → the same Layer-3
  "snapshot + no clean-shutdown marker" inference handles both; the reason is disambiguated from the
  breadcrumb tail (last `GPUOutOfMemoryError`/GPU activity ⇒ `webgpu-device-lost`/`oom`).

## Decision this drives

- `src/detectors/webgpu.js`: how to distinguish `"destroyed"` (intentional) from unexpected loss, and
  the oversized-buffer / error-rate threshold for `onDeviceLossImminent`.
- Which loss cases are catchable (detector) vs. require Layer-3 inference (the GPU-kills-tab case).
