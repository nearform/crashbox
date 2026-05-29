# Research 02 — iOS tab-discard vs. crash disambiguation

> SPEC §8 #2. **Highest false-positive risk on the primary target.** Status: **todo** (results pending).
> Longest-lead item — data collection starts early. Manual iOS runs only (no CDP on device).

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

- [ ] iOS Safari (iPhone 15 Pro) — iOS: \_\_\_
- [ ] iOS add-to-homescreen PWA (iPhone 15 Pro) — iOS: \_\_\_ (discard behavior differs)

## Results

_(pending — signal table per scenario A–E; identify the discriminator)_

## Decision this drives

- The exact pure heuristic for `src/inference/discard.js` (and its Node-test truth table).
- Guarantee for SPEC §9: "No false-positive crash report on normal iOS tab backgrounding/discard."
