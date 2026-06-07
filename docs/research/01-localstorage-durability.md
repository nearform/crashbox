# Research 01 — localStorage write durability under OOM kill

> The highest-risk assumption in the design. **Status: confirmed on iOS** — under a real WASM OOM
> tab-kill on iPhone 15 Pro, the synchronous localStorage write survived with zero tail loss
> (IndexedDB kept pace). Desktop Chrome also done; desktop Safari + iOS PWA remain nice-to-have.

## Question

When a tab is hard-killed by an OOM, does the _last synchronous_ `localStorage.setItem` actually
reach disk before the renderer dies? And how does IndexedDB (async) compare at the moment of death?
The Layer 1 fallback (most-recent breadcrumb + heartbeat in localStorage) is only trustworthy if the
answer is "yes, the last sync write survives".

## Hypothesis

`localStorage.setItem` is synchronous to the JS API, but the browser may buffer the disk flush. An
OOM `SIGKILL` of the renderer may lose the last write(s). IndexedDB, being async, is expected to lose
_more_ at the tail. We need to quantify the tail loss for each store.

## Method

- Spike page: [`spikes/01-localstorage-durability.html`](./spikes/01-localstorage-durability.html) —
  writes a monotonic counter `n` to localStorage (sync) and IndexedDB (async, fire-and-forget) on
  every tick.
- CDP harness: [`spikes/01-driver.mjs`](./spikes/01-driver.mjs) (dependency-free, Node 24 global
  `fetch`/`WebSocket`). Serves the page over HTTP, launches Chrome with remote debugging, runs the
  loop, samples the live `window.__n` **out of process** (so the reference survives renderer death),
  kills the renderer, reloads, and compares what each store retained vs. the reference.
- Two kill modes: `--mode crash` (CDP `Page.crash`, deterministic renderer kill) and `--mode oom`
  (page allocates 8 MB `Uint8Array`s in a loop to induce a real allocation-driven kill).
- `loss = reference_n − survived_n` (clamped at 0; >0 means tail writes lost).

Reproduce: `cd docs/research/spikes && node 01-driver.mjs --mode crash --runs 3`.

## Environments to cover

- [x] Desktop Chrome (CDP-driven, automated) — **Chrome 148.0.7778.216, macOS** ✅ done
- [ ] Desktop Safari (manual, MacBook B) — version: \_\_\_
- [x] iOS Safari (manual, iPhone 15 Pro) — **iOS 18.7, Safari 26.3** — **JS-OOM vector does not hard-kill** (below)
- [ ] iOS add-to-homescreen PWA (manual, iPhone 15 Pro) — iOS: \_\_\_

## Results

### Desktop Chrome 148 (macOS), 2026-05-28

**Mode `crash` (`Page.crash`, precise pre-crash reference), 3 runs:**

| run | reference_n | localStorage survived | IndexedDB survived | LS tail loss | IDB tail loss | LS − IDB |
| --- | ----------- | --------------------- | ------------------ | ------------ | ------------- | -------- |
| 1   | 503         | 503                   | 503                | 0            | 0             | 0        |
| 2   | 503         | 504                   | 504                | 0            | 0             | 0        |
| 3   | 503         | 503                   | 503                | 0            | 0             | 0        |

→ **Zero tail loss for both stores, and localStorage and IndexedDB stayed in exact lockstep.**
Chrome flushes both stores on renderer teardown; the synchronous localStorage write is durable
across an abrupt renderer kill, and async IDB was equally durable here.

**Mode `oom` (real 8 MB-chunk allocation loop), 3 runs:** the tab did **not** hard-crash
(`crashed: false`) within 30 s on this 64 GB machine — large allocations threw a _catchable_
`RangeError` and the write loop kept running; everything survived (LS == IDB, e.g. 8259 == 8259).

→ On a high-RAM desktop, runaway allocation surfaces as a catchable `RangeError`, **not** a hard tab
kill. The hard, unrecoverable OOM tab-kill is a memory-constrained / iOS phenomenon.

### iOS Safari 26.3 / iOS 18.7 (iPhone 15 Pro), 2026-05-28 — JS-allocation OOM does NOT hard-kill

Ran the "Start write loop + induce OOM" path on the device (remote-inspected from a MacBook). At
**n ≈ 4200** the allocation loop logged **`alloc threw: RangeError: Out of memory`** (caught) and the
**tab stayed alive** — same behavior as desktop Chrome, _not_ a tab kill.

→ **A JS `ArrayBuffer` allocation loop is not a valid OOM-kill vector on iOS Safari** — it surfaces a
catchable `RangeError`, the tab survives, and there is no process death to test durability against.
The realistic hard-kill OOM vectors are **WASM linear-memory growth, WebGPU/GPU memory, and large
media** (the flagship in-browser-LLM case), which are exercised later via the detectors/demo, plus
the **iOS tab-discard**, which _is_ a genuine renderer termination (see
[02-ios-discard-vs-crash.md](./02-ios-discard-vs-crash.md)). Kill-durability of the localStorage
fallback on iOS is therefore validated through those paths, not this one.

### iOS Safari 26.3 / iOS 18.7 (iPhone 15 Pro), 2026-05-29 — real WASM OOM kill: DURABILITY CONFIRMED

The JS-allocation vector can't kill the tab (above), but **WebAssembly.Memory growth + touching the
pages does** — this is the realistic OOM vector (the in-browser-LLM case). Spike page
[`spikes/03-real-oom-crash.html`](./spikes/03-real-oom-crash.html) runs the durable counter (sync
localStorage + async IDB) in the **same tab** that blows up WASM memory, then reports what survived.

User confirmed the tab **crashed and auto-reloaded**. Recovered after the crash:

```json
{
  "wasDiscarded": false,
  "navigationType": "navigate",
  "heartbeatAgeMs": 781,
  "lastPagehide": null,
  "localStorage_n": 2886,
  "indexedDB_n": 2886,
  "localStorage_minus_idb": 0
}
```

→ **Under a genuine iOS Safari OOM tab-kill, the synchronous `localStorage` write survived with zero
tail loss, and IndexedDB committed to the exact same point (`localStorage_n === indexedDB_n`, gap 0).**
The load-bearing Layer-1 assumption holds on the primary target. `lastPagehide: null` confirms **no
graceful event fires before the hard crash** — see [02](./02-ios-discard-vs-crash.md) for the full
crash vs. discard signature analysis.

## Interpretation & caveats

- The localStorage-sync assumption **holds on both desktop Chrome and iOS Safari**: nothing is lost
  at the tail, and IndexedDB kept exact pace in every run.
- **`Page.crash` is a relatively graceful renderer abort** (intentional crash path) and may flush
  storage more readily than a true OOM `SIGKILL`, so the desktop result alone is a _lower bound_ on
  durability. The decisive case is the iOS one below.
- The decisive case — a **hard OOM kill on memory-constrained iOS Safari** — was reproduced via WASM
  memory growth (the JS-allocation vector can't kill the tab) and **confirmed**: the synchronous
  localStorage write survived with zero tail loss. This is the load-bearing result; desktop numbers
  do not transfer on their own.

## Decision this drives

- The load-bearing Layer-1 assumption **holds on the primary target**: the synchronous localStorage
  write is durable across a real iOS OOM kill, so it can carry the last-gasp heartbeat/crumb, and
  localStorage is sufficient as the sole store (IndexedDB deferred — see
  [FUTURE_WORK.md](../work/FUTURE_WORK.md)).
- Heartbeat cadence: the zero-tail-loss result means the default ~2s cadence needs no shrinking on
  durability grounds.
