# crashbox — future work

Deliberately **out of scope.** These are real, tracked ideas — not forgotten — but none are needed
today, and several are low ROI for the primary target (iOS Safari). Pull one up only when a consumer
need justifies it.

> **Already shipped (not future work):** the `namespace` option (isolates co-hosted apps on one
> origin) and a `retentionMs` orphaned-record sweep.

---

## Same-app multi-tab recovery

Two tabs of the **same** app on one origin share localStorage keys (the `crashbox:<ns>:current`
pointer and the records), so concurrent tabs can interfere with each other's recovery — one tab's
`init` can recover and delete another's still-live session. (Different apps avoid this with distinct
`namespace`s; this is specifically the _same app, multiple tabs_ case, which v1 does not solve.)

Clean per-tab recovery needs a **tab-scoped value that survives the crash-reload** so the reloaded
tab can find its own prior session. `sessionStorage` is the only candidate, but whether it survives
an iOS Safari OOM crash-reload is **unverified** (the spec says it survives "reloads and restores,"
but iOS Safari has documented sessionStorage quirks, and we haven't device-tested the crash case).
There is no no-regret fallback: a brand-new tab and a tab that lost `sessionStorage` are
indistinguishable, so falling back to a global pointer reintroduces the collision for every new tab.

**Decision (v1):** descoped. If revisited, first settle the empirical question with a device probe
(`sessionStorage.setItem` before a crash, `getItem` after the reload). If it survives, implement
strict per-tab keying; if not, this stays a documented limitation.

## `onCrashRecovered` delivery / acknowledgement

Delivery is **fire-once**: the previous record is consumed (deleted) during `init`, before the
callback returns. If the app's handler throws or the page dies mid-handling, the record is gone. A
hardening would defer deletion until the record is acknowledged — either an explicit ack API, or a
"delivered" marker cleared on the next clean `init`. Edge-case robustness, not currently needed.

## Reporting API corroboration

Ingest the browser-native `crash` report and set `CrashRecord.corroborated = true` when it confirms
the inferred reason (today `corroborated` is always `false`).

**Why it's deferred — it adds almost nothing:**

- **Chromium crashes are already detected and recovered** by the existing cross-browser heuristic
  (localStorage black box + no clean-shutdown marker + breadcrumb-trail inference). The Reporting API
  is _not_ needed to catch them; it only flips a confidence flag.
- **It's Chromium-only.** iOS Safari — the primary target — has no `crash`-report delivery, so the
  heuristic is load-bearing there regardless.
- **Delivery is awkward and server-bound.** A crash kills the page, so a `ReportingObserver` can't
  observe its own renderer's death; Chromium queues the `crash` report to a configured
  `Reporting-Endpoints` server, not readily to a fresh client-side page. crashbox is local-only
  (no backend), so wiring this up is non-trivial.

**The one genuine value-add** (if revisited): when the heuristic returns `hard-kill` / `unknown`
because the breadcrumb trail was empty, a `crash` report's `reason` (e.g. `oom`) could fill it in.
A minimal version — "if a `ReportingObserver` `crash` report happens to be available on load, ingest
it to set `corroborated` and backfill an empty reason" — is the most that's worth doing, and only
once there's a server or a Chromium-specific need.

## Module-internal memory-growth tracking

Both detectors hook the **JS-side** APIs: the WASM detector wraps `WebAssembly.Memory.prototype.grow`
and the WebGPU detector wraps `queue.writeBuffer`. These catch JS-initiated growth — including
emscripten's `_emscripten_resize_heap`, the dominant real-world WASM/LLM path. They do **not** catch a
pure module-internal `memory.grow` instruction or engine-internal GPU allocation, which bypass the JS
methods. A committed OOM driven entirely by internal growth, with no JS-side signal, would recover as
`hard-kill` instead of `oom` / `webgpu-device-lost`.

**Fix-forward:** keep references to created/exported memories and poll their `buffer.byteLength` on a
throttled interval, feeding the same pressure thresholds. An edge case (most runtimes grow via JS),
but the honest gap. See [research §3 follow-up](../research/03-webgpu-device-loss.md) and
[research §6](../research/06-memory-pressure.md).

## IndexedDB richer store

The store is **localStorage-only** (see [SPEC.md](./SPEC.md)): a synchronous localStorage write
survives a real iOS OOM and the black box is KB-sized, so IndexedDB was dropped. Revisit only if a
consumer needs a larger / richer box (bigger snapshots, structured-clone fidelity, more history)
than localStorage + JSON can carry.

## Heartbeat-staleness threshold tuning

`classifyReason` treats any recorded heartbeat (`heartbeatAgeMs != null`) as enough to call a
no-cause crash a `hard-kill`. A tuned `> N × heartbeatMs` threshold is possible, but the binary
check is fine in practice — [research §2](../research/02-ios-discard-vs-crash.md) showed a crash
auto-reloads fast, so a _short_ gap doesn't rule out a crash. Revisit only if false `hard-kill`s
show up in the field.

## Server upload hook

A non-goal (see [SPEC.md](./SPEC.md)): data stays 100% local. An optional hook to ship recovered
records to a backend (and the Reporting-Endpoints corroboration above) could come later.

---

## Open on-device validation (non-blocking)

Capturing a real `wasDiscarded:true` iOS discard remains the one unconfirmed link in the
no-false-positive guarantee (iOS 18.7 / 8 GB resisted it twice). It is **non-blocking** —
`wasDiscarded` can only ever _suppress_ a crash, never create a false positive — and the everyday
backgrounding false-positive cases are already device-confirmed. Tracked in
[research §2](../research/02-ios-discard-vs-crash.md); listed here so it's visible as deferred, not
dropped.
