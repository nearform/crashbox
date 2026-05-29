# crashbox — Specification & Handoff

> Status: **draft spec for implementation**. Project name: `crashbox`.
> Language: **pure JavaScript with JSDoc type annotations** (no TypeScript syntax; `tsc --checkJs` for type checking).
> License intent: MIT. Zero runtime dependencies in the core.

---

## 0. Resolved decisions & open questions (added during planning, 2026-05-28)

These supersede anything below that contradicts them.

**Resolved:**

- **Single package, not a monorepo.** §6 originally proposed `@crashbox/core|webgpu|wasm`. The
  scaffold and the §5 public API are a single `crashbox` package (`import * as crashbox`). We ship
  **one package**; the "layers" become internal `src/` modules with conceptually tree-shakeable
  detectors. §6 has been rewritten accordingly.
- **Docs live in `docs/`.** This spec and the §8 research findings live under `docs/` (out of the
  published `files` and the demo-page copy).
- **Research spikes run before SDK code.** The riskiest assumptions (§8 #1 localStorage durability,
  #7 snapshot cost, #2 iOS discard-vs-crash) are validated on throwaway pages first. See
  `docs/research/`.
- **Real iOS hardware is available** (iPhone 15 Pro) for the iOS-Safari validation.
- **v1 is localStorage-only; IndexedDB is deferred.** Research §8 #1 showed a synchronous
  `localStorage` write survives a real iOS OOM kill with zero loss, and the black box is KB-sized, so
  IDB (the spec's original "primary store") is not needed for v1. Layer 1 below should be read as
  "localStorage is the store" for now; IDB returns only if a consumer needs a larger/richer box.
- **Lean module structure (~5 files), not ports/adapters.** The pure logic (`blackbox.js`,
  `inference.js`) is unit-testable with plain data and no dependency injection; `index.js` does the
  browser wiring directly and `detectors.js` holds the opt-in wrappers. The earlier ports/adapters
  scaffold was collapsed (it only bought Node-testability of the orchestration, which the demo +
  device already cover). See [DESIGN.md](./DESIGN.md). §6 reflects the lean layout.

**Open design questions to resolve during implementation** (see §3/§5 notes):

- **Multi-tab / shared-origin:** IndexedDB + localStorage are origin-shared. Concurrent tabs writing
  heartbeat / clean-shutdown to global keys corrupt inference. Need per-session/tab key namespacing
  and a "which session am I recovering" rule.
- **Retention / cleanup:** when are old sessions' snapshots evicted (after `onCrashRecovered`)?
- **`onCrashRecovered` delivery:** fired once vs. until acknowledged? Needs an ack/clear step.
- **Snapshot serialization contract:** `structuredClone` (IDB) vs JSON (localStorage) differ in
  capability. Define allowed input and behavior on un-serializable state. (Drives §8 #7.)
- **Reason precedence:** explicit priority when multiple signals fire (e.g. `device.lost` +
  memory-near-cap).
- **Heartbeat staleness threshold** for `hard-kill` classification (e.g. `> N × heartbeatMs`).
- **`onMemoryPressure` source:** no `performance.memory` on Safari; define a cross-browser trigger.
- **`attachGPUDevice` when the `webgpu` detector is disabled:** define no-op / queue / auto-enable.

---

## 1. Problem

When a browser tab dies hard — WebGPU device loss / GPU-process kill, WASM out-of-memory, or an
in-browser LLM exhausting memory — no JavaScript runs at the moment of death. Existing tools
(Sentry, Bugsnag) catch JS exceptions and unhandled rejections but **not** hard tab crashes, and the
only browser-native crash signal (the Reporting API `crash` report) is Chromium-only, server-bound,
and carries almost no debug detail. None of this helps on the primary target: **iOS Safari**, where
WebGPU/WASM workloads can kill the whole tab and there is no Reporting API, no extensions, and
unreliable unload events.

`crashbox` is a **drop-in JS SDK** that:

1. Continuously persists a tiny "black box" (recent breadcrumbs + current state snapshot) to storage
   that survives the renderer process dying.
2. On the **next load**, infers whether the previous session crashed and why, and surfaces the
   recovered record to the embedding app for display to the user or internal debugging.
3. Where possible, fires **early-warning** callbacks (memory pressure, imminent device loss) so the
   app can checkpoint or shed load _before_ death.

### Non-goals (v1)

- No server backend. Data stays 100% local; an upload hook may come later but is out of scope.
- Not a frame-level GPU debugger (that space is covered by `webgpu_inspector`).
- Cannot guarantee recovery _of_ a crash in progress — the renderer is gone. We guarantee that the
  last-known-good state was durably written _before_ the crash, and we reconstruct the picture after.

---

## 2. Core insight (read this before designing anything)

**You cannot run code during a hard crash.** Therefore the entire design reduces to:

> Persist a small state snapshot to durable storage on a throttled cadence, write a "clean shutdown"
> marker on graceful exit, and on the next load decide: _snapshot present + no clean-shutdown marker
> = the previous session crashed._

Everything else (detectors, reason inference, early warning) is enrichment on top of that spine.

Two hard constraints fall out of this:

- **The instrumentation must not cause the crash it's trying to catch.** Sentry historically grew
  memory until the browser died while collecting error data. The hot path must allocate almost
  nothing and writes must be throttled/coalesced.
- **The black box must stay tiny** (KB, not MB) to survive storage quota pressure and eviction.

---

## 3. Architecture

Three layers. Implement in this order.

### Layer 1 — The black box (durable write path)

> **v1 update (see §0):** the primary store is **localStorage**, not IndexedDB. Research §8 #1 showed
> sync localStorage survives a real iOS OOM with zero loss and the box is KB-sized, so IDB is deferred.
> Read "IndexedDB" below as the deferred richer-store option; "localStorage fallback" is now the store.

- **Primary store: IndexedDB.** Survives tab crash, async, large quota. Holds the breadcrumb ring
  buffer and the latest state snapshot, keyed by `sessionId`.
- **Synchronous fallback: `localStorage`** for the single most-recent breadcrumb + heartbeat. A
  synchronous write is guaranteed flushed before the next line executes, which matters when there
  are milliseconds before death (async IndexedDB writes may not commit in time).
  _(Open: §8 #1 must confirm sync writes actually flush to disk before an OOM kill.)_
- **Heartbeat:** write `lastSeen` timestamp every N seconds (default ~2s). Lets the next session
  estimate time-of-death and distinguish "crashed" from "navigated away cleanly".
- **Write policy:** coalesce breadcrumbs; flush snapshot on significant events or every N ms,
  whichever the consumer configures. Backpressure: drop oldest breadcrumbs when ring is full.
- **Open: multi-tab key namespacing** (IDB/localStorage are origin-shared — see §0).

### Layer 2 — Detectors (pluggable, source-specific, priority order)

**WebGPU (implement first — primary v1 target):**

- Wrap `GPUDevice`. Attach to `device.lost` (resolves `{ reason, message }`; distinguish
  `"destroyed"` (intentional) from unexpected loss) and listen for `uncapturederror`.
- Maintain a rolling log of recent GPU activity: pipeline/buffer creation, buffer byte sizes,
  `queue.submit` counts. On loss, the last snapshot shows what the GPU was doing.
- Heuristic early warning: flag oversized buffer allocations or rising `uncapturederror` rate —
  fire `onDeviceLossImminent`.
- **Limitation:** `device.lost` catches _graceful_ loss. A full GPU-process kill that takes the tab
  down with it is caught only by Layer 3's after-the-fact inference.

**WASM:**

- Wrap `WebAssembly.Memory` / instantiation. Track linear-memory growth as a leading OOM indicator.
- Trap `RangeError` / `abort` from the module.

**JS / general:**

- `onerror`, `onunhandledrejection`, and a `PerformanceObserver` for long tasks.

### Layer 3 — Crash inference (runs on next load)

- On graceful exit, write a **clean-shutdown flag**. Use `pagehide` and
  `visibilitychange → hidden` as the reliable last-gasp events. **Do not rely on `beforeunload` /
  `unload`** — unreliable on mobile, especially iOS.
- On startup: load the previous `sessionId`. If a live snapshot exists but **no clean-shutdown flag
  → classify as crash.** Infer reason from the tail of the breadcrumb log:
  - `device.lost` recorded → `"webgpu-device-lost"`
  - memory near cap / `RangeError` → `"oom"`
  - nothing but a stale heartbeat → `"hard-kill"` (unknown)
- **Reason precedence** (open, see §0): define ordering when multiple signals are present.
- **Corroboration:** if a Reporting API `crash` payload is available (Chromium), ingest its
  `reason` (e.g. `"oom"`) to confirm the heuristic. On iOS Safari this is absent, so the heuristic
  carries the full weight.

---

## 4. iOS Safari realities (the main target — design around these)

- No Reporting API, no extensions, flaky `unload`. Lean on `pagehide` + IndexedDB + `localStorage`
  heartbeat.
- **iOS aggressively discards backgrounded / memory-heavy tabs and silently reloads them.** This
  looks identical to a crash unless handled. The SDK MUST distinguish an iOS tab-discard-reload from
  a genuine crash (e.g. via `document.wasDiscarded`, backgrounded-then-foregrounded timing, and
  whether a `pagehide` with `persisted=true` fired) — otherwise it cries wolf on every backgrounding.
  _(See §8 #2 / `docs/research/02-ios-discard-vs-crash.md`.)_
- Storage quota is tighter and eviction can happen under memory pressure — keep the black box minimal.

---

## 5. Public API (sketch — JSDoc-typed JS)

```js
/**
 * @typedef {Object} CrashRecord
 * @property {string} sessionId
 * @property {"webgpu-device-lost"|"oom"|"hard-kill"|"unknown"} reason
 * @property {number} lastSeen            Epoch ms of final heartbeat (est. time of death).
 * @property {Breadcrumb[]} breadcrumbs   Tail of the ring buffer.
 * @property {object|undefined} snapshot  Last app-provided state snapshot.
 * @property {boolean} corroborated       True if Reporting API confirmed the reason.
 */

/**
 * @typedef {Object} CrashboxOptions
 * @property {number} [heartbeatMs=2000]
 * @property {number} [breadcrumbLimit=100]
 * @property {Array<"webgpu"|"wasm"|"js">} [detectors=["js"]]
 * @property {(r: CrashRecord) => void} [onCrashRecovered]
 * @property {() => void} [onMemoryPressure]
 * @property {(info: {reason?: string}) => void} [onDeviceLossImminent]
 */

/** @param {CrashboxOptions} [options] */
export function init(options) {
  /* ... */
}

/** Record a breadcrumb. Must be cheap; no allocation beyond the entry. */
export function breadcrumb(
  /** @type {string} */ msg,
  /** @type {object} */ [data],
) {}

/** Provide/replace the current state snapshot (deep-cloned + size-capped before persist). */
export function setSnapshot(/** @type {object} */ state) {}

/** Register a WebGPU device so the detector can wrap it. */
export function attachGPUDevice(/** @type {GPUDevice} */ device) {}
```

Embedding example:

```js
import * as crashbox from "crashbox";

crashbox.init({
  detectors: ["webgpu", "js"],
  onCrashRecovered(record) {
    if (record.reason === "webgpu-device-lost") showRecoveryBanner(record);
    else logToConsole(record);
  },
  onDeviceLossImminent() {
    checkpointAndReduceLoad();
  },
});

const device = await adapter.requestDevice();
crashbox.attachGPUDevice(device);
```

---

## 6. Package layout (single package, lean — revised)

> **Revised twice.** Originally a monorepo (rejected → single package), then a ports/adapters
> scaffold (rejected → lean). crashbox ships as **one** zero-dependency package (`crashbox`), and v1
> is **~5 files, localStorage-only** (see §0). The pure logic lives in two dependency-free modules
> that are unit-tested directly; `index.js` does the browser wiring; `detectors.js` holds the opt-in
> wrappers. IndexedDB and a ports/adapters boundary can return later if a consumer needs them.

```
crashbox/
  src/
    index.js        # public API (init/breadcrumb/setSnapshot/attachGPUDevice) + browser wiring:
                    #   localStorage black box, heartbeat, pagehide{persisted:false} marker, recover
    types.js        # JSDoc @typedef hub (CrashRecord, Breadcrumb, CrashboxOptions, LoadSignals, …)
    blackbox.js     # PURE: ring buffer (allocation-light) + JSON snapshot serialize/size-cap
    inference.js    # PURE: classifyLoad (discard-vs-crash guard) + classifyReason
    detectors.js    # opt-in source wrappers: js / webgpu / wasm (enrichment, not the crash catch)
  test/             # node --test; pure modules tested directly. Browser fakes (happy-dom,
                    #   fake-indexeddb) live here if/when needed, never in src/
  docs/             # this spec + research findings + DESIGN.md (not published, not in demo copy)
  index.html        # demo / integration harness (imports ./src/index.js, no build step)
```

- Pure JS + JSDoc; `tsc --checkJs --noEmit` in CI for type safety, no build-time transpile required.
- Core has **no runtime dependencies** and an allocation-light hot path. Test-only fakes
  (`fake-indexeddb`, `happy-dom`) are **devDependencies** imported only from `test/`.
- `blackbox.js` + `inference.js` are pure (plain data in/out) → unit-tested in Node with no DI;
  `index.js`/`detectors.js` browser wiring is validated via the demo + the real device.

---

## 7. Crash-induction demo page

A single demo page that wires up `crashbox` and offers a panel of buttons, each of which triggers a
**different kind of crash or near-crash** on demand. This is the primary way to watch the SDK work:
trigger a crash, let the tab die, reload, and confirm the recovered record (reason, breadcrumbs,
snapshot, time-of-death) shows up via `onCrashRecovered`.

> Out of scope here: how the page is served, bundled, and styled — that already lives in the repo.
> This section specifies only **what to trigger and how**, plus what the page must show.

### What the page must do

- `init` crashbox with all detectors enabled and an `onCrashRecovered` handler that renders the
  recovered record prominently at the top of the page (so a crash from the _previous_ load is the
  first thing you see after reload). Include the inferred `reason`, `lastSeen` delta, the breadcrumb
  tail, and the snapshot.
- Continuously call `setSnapshot` with a counter/timestamp and drop a `breadcrumb` on each button
  press, so every crash leaves a recognizable trail to verify against.
- Show live state where available: a memory readout (`performance.memory` /
  `measureUserAgentSpecificMemory()` where supported), current `sessionId`, and heartbeat ticks.
- Provide a **clean reload** button (graceful `pagehide` path) as the negative control — it must
  produce **no** crash record, proving the clean-shutdown flag works.

### Crash triggers (each a button)

Grouped by detector, in the project's priority order. Some are genuine hard kills; some are
graceful/catchable — the demo should label which is which so the tester knows what to expect.

**WebGPU (primary target):**

1. **Graceful device loss** — call `device.destroy()`. Catchable: `device.lost` resolves with
   reason `"destroyed"`. Tab survives. Verifies the wrapped-device happy path.
2. **Oversized buffer allocation** — request a `GPUBuffer` far larger than `maxBufferSize` /
   available VRAM. Expect `uncapturederror` and possibly device loss.
3. **GPU work flood** — submit a runaway compute/render loop (e.g. an unbounded dispatch or a
   shader with a huge loop) to push the GPU process toward a kill that may take the tab. This is the
   case that exercises Layer 3 inference rather than `device.lost`.
4. **Invalid/oversized texture** — allocate textures until allocation fails, to surface
   driver-level errors distinct from buffer OOM.

**WASM / memory:** 5. **Linear-memory blowup** — grow a `WebAssembly.Memory` in a loop until `RangeError`, then keep
allocating to push toward OOM. Verifies the growth early-warning and the `"oom"` inference. 6. **JS heap exhaustion** — allocate large `ArrayBuffer`s / push into an array in a tight loop until
the tab dies. The classic hard OOM kill with no graceful event — pure Layer 3 inference test.

**In-browser LLM (flagship scenario):** 7. **Load oversized model** — kick off loading a quantized model deliberately too large for the
device, or run inference with an oversized context, to reproduce the real-world LLM OOM tab death
on iOS. This is the motivating demo and the most important manual validation.

**General / control:** 8. **Uncaught exception** — `throw` from a `setTimeout`. Catchable by the JS detector; tab survives. 9. **Unhandled rejection** — reject a promise with no handler. Catchable; tab survives. 10. **Unresponsive / long task** — block the main thread in a tight infinite loop. On some browsers
this triggers an `"unresponsive"`/hang kill; verifies long-task breadcrumbs and hang inference. 11. **Chromium-only native crash** — a button that instructs the tester to paste `chrome://crash`
or `chrome://memory-exhaust` into the address bar (these are not navigable from script by
design). Lets you corroborate the Reporting API `crash` path against the heuristic.

### iOS-specific manual cases (no button — documented test steps on the page)

- **Backgrounding / tab discard** — instructions to background the tab, open many others to force
  iOS to discard it, then return. Must produce **no** crash record (the discard-vs-crash heuristic,
  research item #2). This is the most important false-positive guard.
- **Add-to-homescreen PWA OOM** — repeat trigger #7 from a homescreen-launched instance, where iOS
  memory limits are tighter and discard behavior differs.

### Demo acceptance

- Each genuine-kill trigger, followed by reload, yields a crash record with the **correct inferred
  reason** and a breadcrumb trail ending at the button that was pressed.
- Each catchable trigger is caught live (no tab death) and recorded as a breadcrumb, not a crash.
- The clean-reload control and the iOS-discard case both yield **no** crash record.

---

## 8. Research directions for Claude Code (open questions to investigate)

Each item below is a discrete investigation task. Validate empirically — much of this is
browser-version-specific and undocumented. Findings live in `docs/research/` (see its README for
status).

1. **`localStorage` write durability under crash.** Confirm that a synchronous `localStorage.setItem`
   is actually flushed to disk before an OOM kill on iOS Safari. Build a repro that exhausts memory
   and check what survives. This assumption underpins Layer 1. → `01-localstorage-durability.md`

2. **iOS tab-discard vs. crash disambiguation.** Determine the most reliable signal set:
   `document.wasDiscarded`, `pagehide.persisted`, `visibilitychange` timing, BFCache behavior.
   Goal: zero false-positive crash reports on normal backgrounding. → `02-ios-discard-vs-crash.md`

3. **WebGPU device-loss taxonomy.** Catalog `GPUDevice.lost` `reason`/`message` values across
   Chrome, Safari 18+, Firefox: which losses leave the tab alive (catchable) vs. take the tab with
   them (inference-only)? Map `uncapturederror` as a leading indicator.

4. **GPU-process-kill-takes-tab case.** Can anything be persisted in the window between an
   `uncapturederror` storm and full tab death? Measure the time budget.

5. **Reporting API `crash` ingestion locally.** The report normally goes to a server endpoint —
   investigate whether a service worker or local endpoint can capture it for the _same device's_
   next session (Chromium only), to corroborate the heuristic without phoning home.

6. **Memory pressure leading indicators.** Evaluate `performance.measureUserAgentSpecificMemory()`,
   `navigator.deviceMemory`, and `WebAssembly.Memory` growth as early-warning triggers. Quantify how
   much warning time each gives before OOM. (Note Safari support gaps.)

7. **Snapshot serialization cost.** The snapshot deep-clone + size-cap must not itself spike memory
   or block the main thread. Investigate `structuredClone`, size budgeting, and whether a Worker can
   own the persist path safely. → `07-snapshot-serialization.md`

8. **In-browser LLM OOM profile.** Using a quantized model (Phi-3 Mini / TinyLlama via WebGPU/WASM),
   characterize the memory curve approaching a crash on iOS. This is the flagship demo and the most
   important real-world validation.

9. **Black-box size budget.** Find the largest black box that reliably survives iOS storage eviction
   under memory pressure. Sets `breadcrumbLimit` and snapshot-cap defaults.

---

## 9. Acceptance criteria for v1

- [ ] Embedding app gets a correct `onCrashRecovered` after a WebGPU device-loss crash in
      Chrome **and** iOS Safari.
- [ ] No false-positive crash report on normal iOS tab backgrounding/discard.
- [ ] Reason correctly inferred for: graceful device loss, WASM/LLM OOM, and unknown hard kill.
- [ ] SDK overhead measured: hot path allocation-light; no measurable contribution to OOM.
- [ ] Works as plain `<script type="module">` import with zero build step.
