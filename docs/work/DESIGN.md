# crashbox — design map

How the `src/` modules map to the research findings ([docs/research/](../research/)) that drive
them. A small core (~5 files), `localStorage`-only. See [SPEC.md](./SPEC.md) for the design
rationale.

## Architecture: lean, localStorage-only

- **Pure modules** — `blackbox.js` (ring buffer + JSON snapshot) and `inference.js` (classify +
  discard guard) — take plain data, touch no platform APIs, and are unit-tested directly under
  `node --test` (no dependency injection needed).
- **`index.js`** does the browser wiring directly: a `localStorage`-backed black box (a synchronous
  write survives a real iOS OOM, so IndexedDB is deferred — [research §1](../research/01-localstorage-durability.md)),
  a heartbeat, the `pagehide{persisted:false}` clean-shutdown marker, and recover-on-load.
- **`detectors.js`** holds the opt-in source wrappers (js / webgpu / wasm) — enrichment, since the
  hard kill itself has no live event and is caught by inference on the next load.

Browser-only wiring is validated via the demo and real iOS hardware; the load-bearing _logic_ is
the part that's unit-tested.

## Module → finding

| Module         | Role                                          | Research finding                                                                   |
| -------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `index.js`     | Public API + browser wiring                   | #1 — localStorage-only black box; #2 — clean marker on `pagehide{persisted:false}` |
| `types.js`     | JSDoc typedef hub                             | —                                                                                  |
| `blackbox.js`  | ring buffer + JSON snapshot serialize/cap     | allocation-light hot path; #7 JSON, ~16–32 KB, no `structuredClone`                |
| `inference.js` | classifyLoad (discard guard) + classifyReason | #2 `wasDiscarded` suppressor; #1/#4 GPU+WASM OOM hard-kill, reason from tail       |
| `detectors.js` | js / webgpu / wasm wrappers                   | #6 no longtask/memory API on iOS; #3/#4 `GPUOutOfMemoryError` precedes the kill    |

## Deferred

Reporting API corroboration, same-app multi-tab recovery, IndexedDB, module-internal memory-growth
tracking, and a server upload hook are out of scope — see [FUTURE_WORK.md](./FUTURE_WORK.md). The
one open on-device validation (capturing a real `wasDiscarded:true` discard) is non-blocking, since
`wasDiscarded` can only ever _suppress_ a crash, never create a false positive
([research §2](../research/02-ios-discard-vs-crash.md)).
