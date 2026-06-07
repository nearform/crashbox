# Research 02 — iOS tab-discard vs. crash disambiguation

> The highest false-positive risk on the primary target. **Status: discriminator synthesized** on
> iOS 18.7 / Safari 26.3 (iPhone 15 Pro) — see [Synthesized discriminator](#synthesized-discriminator-ios-187--safari-263).
> One open item: capturing an actual `wasDiscarded:true` discard (iOS resisted it twice). It's
> non-blocking — `wasDiscarded` can only ever suppress a crash, never create a false positive — and
> is tracked in [FUTURE_WORK.md](../work/FUTURE_WORK.md).

## Question

iOS aggressively discards backgrounded / memory-heavy tabs and silently reloads them. To the SDK this
looks identical to a crash. Which signal set reliably separates a **normal discard-reload** (must
produce NO crash record) from a **genuine crash** (must produce one)? Candidates:
`document.wasDiscarded`, `pagehide` with `persisted=true/false`, `visibilitychange` timing, BFCache
restore (`pageshow.persisted`).

## Method

Spike page: [`spikes/02-ios-discard-vs-crash.html`](./spikes/02-ios-discard-vs-crash.html).

The page logs every lifecycle signal with timestamps to durable storage and prints the accumulated
log on load. Run these scenarios on the iPhone 15 Pro and record the signal set for each:

- [ ] **A. Background + immediate return** (home gesture, then reopen). Expect: clean, no crash.
- [ ] **B. Background + forced discard** — background it, open ~10–15 heavy tabs / apps to push memory
      until iOS discards it, then return (tab silently reloads). The case that must NOT be a crash.
- [ ] **C. Genuine OOM crash** — trigger memory exhaustion (reuse Spike 1's loop). Must BE a crash.
- [ ] **D. Clean reload** — pull-to-refresh / reload button. Negative control.
- [ ] **E. BFCache back/forward** — navigate away and back.

For each: record `document.wasDiscarded`, last `pagehide.persisted`, the `visibilitychange→hidden`
timestamp, `pageshow.persisted`, and the heartbeat age at reload.

## Environments to cover

- [x] iOS Safari (iPhone 15 Pro) — **iOS 18.7, Safari 26.3** — crash signature + leaving-signatures captured; discriminator synthesized (real discard `wasDiscarded:true` still uncaptured, non-blocking)
- [ ] iOS add-to-homescreen PWA (iPhone 15 Pro) — iOS: \_\_\_ (discard behavior differs)

## Results

### iOS Safari 26.3 / iOS 18.7 (iPhone 15 Pro), 2026-05-29

**Scenario A — background ~3 s + return (the false-alarm baseline):**

```
load        wasDiscarded:false  navigationType:"navigate"  heartbeatAgeMs:null
pageshow    persisted:false
visibilitychange  state:"hidden"     (on backgrounding)
visibilitychange  state:"visible"    (on return)
```

- The tab stayed **fully alive**: no reload, no new `load` event, `bootSeq` unchanged.
- Backgrounding fired **`visibilitychange:hidden` only — NO `pagehide`** and no `freeze`.
- **Key implication:** the SDK must **not** treat `visibilitychange:hidden` as a clean-shutdown
  marker. iOS fires it on every ordinary app-switch; writing the clean-shutdown flag there would
  mask a crash that occurs while the tab is backgrounded (the flag would already say "clean").

**Scenario B attempt — backgrounded under WASM memory pressure from a second tab (~78 s):** the
spike tab was **NOT discarded**. No new `load`, `bootSeq` unchanged, no `wasDiscarded`. iOS 18.7 on
an 8 GB iPhone 15 Pro kept it alive. Along the way two more "leaving" signatures were captured:

```
pagehide  persisted:true   +  visibilitychange:hidden     (Safari tab-switch → BFCache park)
pageshow  persisted:true   +  visibilitychange:visible    (~2 s later, BFCache restore)
visibilitychange:hidden  →  visibilitychange:visible       (78 s app-switch, NO pagehide)
```

Three distinct non-crash "leaving" signatures, none of which may be read as a crash:

| Action            | Signature                                                     | Tab alive?              |
| ----------------- | ------------------------------------------------------------- | ----------------------- |
| App-switch (home) | `visibilitychange:hidden` only                                | yes                     |
| Safari tab-switch | `pagehide{persisted:true}` + later `pageshow{persisted:true}` | yes (BFCache)           |
| **Discard**       | fresh `load` + `wasDiscarded:true`                            | no — _not yet captured_ |

- **`pagehide{persisted:true}` is a recoverable BFCache park, NOT a shutdown.** Only
  **`pagehide{persisted:false}`** indicates a genuine teardown. The clean-shutdown flag must be
  written only on `pagehide` with `persisted === false`.
- iOS 18.7 proved **reluctant to discard** even under sustained cross-tab WASM memory pressure —
  capturing a real `wasDiscarded:true` may need more aggressive/longer pressure or many tabs.

**Genuine OOM crash (in-tab WASM blowup via
[`spikes/03-real-oom-crash.html`](./spikes/03-real-oom-crash.html)) — tab crashed & auto-reloaded:**

```json
{
  "wasDiscarded": false,
  "navigationType": "navigate",
  "heartbeatAgeMs": 781,
  "lastPagehide": null
}
```

- **`lastPagehide: null`** — a hard crash fires **no `pagehide`** (and no `visibilitychange:hidden`)
  beforehand. There is no death event to catch.
- **`wasDiscarded: false`** on a real crash — so `wasDiscarded` is a _safe_ discard signal: it is
  never set by a crash.
- **`navigationType: "navigate"`** (not `"reload"`) — a crash-reload is indistinguishable from a
  fresh navigation by type; do not rely on it.
- **`heartbeatAgeMs: 781`** — Safari auto-reloads a crashed tab quickly, so a _short_ heartbeat gap
  does NOT rule out a crash. "Stale heartbeat" is unreliable as a crash signal.

## Synthesized discriminator (iOS 18.7 / Safari 26.3)

| Event              | new `load`? | `wasDiscarded` | preceding `pagehide`                  | other                                  |
| ------------------ | ----------- | -------------- | ------------------------------------- | -------------------------------------- |
| App-switch (home)  | no          | —              | none (`visibilitychange:hidden` only) | tab stays alive                        |
| Safari tab-switch  | no          | —              | `persisted:true` (BFCache)            | `pageshow persisted:true` on return    |
| Clean exit/close   | (next load) | false          | **`persisted:false`**                 | the only true clean-shutdown signal    |
| **Discard-reload** | yes         | **true**       | (varies)                              | iOS reluctant to do this; not captured |
| **Crash-reload**   | yes         | **false**      | **none (`lastPagehide:null`)**        | `navigationType:"navigate"`            |

**The heuristic (in `src/inference.js`):**

1. Write the **clean-shutdown marker only on `pagehide` with `persisted === false`** — never on
   `visibilitychange:hidden` and never on `pagehide{persisted:true}` (both are recoverable, not exits).
2. On load, with a prior live session present:
   - `document.wasDiscarded === true` → **iOS discard, suppress** (a crash never sets this).
   - clean-shutdown marker present → **clean exit, no crash.**
   - otherwise (snapshot/heartbeat present, no marker, `wasDiscarded` false) → **CRASH.**
3. Do **not** use `navigationType` or a short `heartbeatAge` to gate the crash decision.

_(Open: capture an actual `wasDiscarded:true` discard — iOS 18.7 resisted it — and the clean-reload
(D) control. Neither blocks the heuristic, since `wasDiscarded:true` is only ever a suppressor.)_

**Follow-up 2026-05-29 (demo, same device):** discard resisted **again** under 4 WebGL
aquariums (30k fish) + YouTube 4K + Google Maps 3D — the backgrounded crashbox tab stayed alive, no
`wasDiscarded`. Web-tab pressure is ineffective (all Safari tabs share one budget); remaining levers
are native-app memory pressure and the add-to-homescreen PWA. Meanwhile the implemented heuristic
**passed on-device**: app-switch (home) and Safari tab-switch (BFCache) both produced no false-
positive crash, and a genuine in-tab WASM OOM kill (~1.5–2 GB physical commit, no death event)
recovered correctly as `oom` from `memory-near-cap` breadcrumbs.

## Decision this drives

- The exact pure heuristic in `src/inference.js` (and its Node-test truth table).
- The guarantee that there are no false-positive crash reports on normal iOS tab
  backgrounding/discard.
