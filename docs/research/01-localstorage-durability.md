# Research 01 — localStorage write durability under OOM kill

> SPEC §8 #1. **Highest-risk assumption in the project.** Status: **in progress** — desktop Chrome
> done (below); desktop Safari + iOS Safari + iOS PWA pending (manual, real hardware).

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
- [ ] iOS Safari (manual, iPhone 15 Pro) — iOS: \_\_\_
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

## Interpretation & caveats

- On desktop Chrome the localStorage-sync-fallback assumption **holds**: nothing is lost at the tail,
  even IDB keeps up. So far so good.
- **`Page.crash` is a relatively graceful renderer abort** (intentional crash path) and may flush
  storage more readily than a true OOM `SIGKILL`. It is a _lower bound_ on data loss, not proof of
  durability under a hard kill.
- The decisive case — a **hard OOM kill on memory-constrained iOS Safari**, where Chrome's desktop
  flush-on-teardown does not apply — remains **untested and is the load-bearing manual run**
  (iPhone 15 Pro). Desktop results do not transfer.

## Decision this drives

- Desktop Chrome: localStorage sync fallback is trustworthy; IDB is also reliable at teardown, so it
  can hold the rich black box and localStorage need only hold the last-gasp heartbeat/crumb.
- **Gate before committing the architecture:** the iOS Safari run. If sync localStorage loses tail
  writes under a real iOS OOM, the heartbeat cadence must shrink and/or the "most-recent crumb"
  fallback design changes. Until then, treat the localStorage fallback as _validated on desktop
  only_.
- Heartbeat cadence: pending the iOS tail-loss number.
