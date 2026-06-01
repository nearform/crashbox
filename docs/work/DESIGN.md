# crashbox — design map

How the `src/` modules map to the research findings ([docs/research/](../research/)) and the
implementation phases. Lean v1 layout (~5 files); each module's header comment cites the finding that
drives it.

## Architecture: lean, localStorage-only

The research collapsed the spec's three-package / ports+adapters design into a small core:

- **Pure modules** — `blackbox.js` (ring buffer + JSON snapshot) and `inference.js` (classify +
  discard) — take plain data, touch no platform APIs, and are unit-tested directly under
  `node --test` (no dependency injection needed).
- **`index.js`** does the browser wiring directly: a `localStorage`-backed black box (research §8 #1
  proved sync localStorage survives a real iOS OOM, so IndexedDB is **deferred** for v1), a heartbeat,
  the `pagehide{persisted:false}` clean-shutdown marker, and recover-on-load.
- **`detectors.js`** holds the opt-in source wrappers (js / webgpu / wasm) — enrichment, since the
  hard kill itself has no live event and is caught by inference on the next load.

Browser-only wiring is validated via the demo + the real device; the load-bearing _logic_ is the
part that's unit-tested.

## Module → finding → phase

| Module         | Role                                          | Research finding                                                                 | Phase        |
| -------------- | --------------------------------------------- | -------------------------------------------------------------------------------- | ------------ |
| `index.js`     | Public API (SPEC §5) + browser wiring         | #1 — localStorage-only black box; #2 — clean marker on pagehide{persisted:false} | 0 done / 2-3 |
| `types.js`     | JSDoc typedef hub                             | —                                                                                | 0 (done)     |
| `blackbox.js`  | ring buffer + JSON snapshot serialize/cap     | §2 allocation-light; #7 JSON, ~16–32 KB, no structuredClone                      | 1            |
| `inference.js` | classifyLoad (discard guard) + classifyReason | #2 `wasDiscarded` suppressor; #1/#4 GPU+WASM OOM hard-kill, reason from tail     | 1            |
| `detectors.js` | js / webgpu / wasm wrappers                   | #6 no longtask/memory API on iOS; #3/#4 `GPUOutOfMemoryError` precedes kill      | 3 / 5 / 6    |

## Phase order

0 toolchain + scaffold (done) → 1 pure core (`blackbox` + `inference`, Node-tested) → 2 wire
`index.js` (localStorage black box + heartbeat + clean-shutdown marker + recover) → 3 JS detector +
demo harness → 5 WebGPU → 6 WASM. **Phases 1–6 are the v1 launch scope — all done and
device-validated.**

The original "Phase 7" (Reporting API corroboration) is **deferred** — Chromium crashes are already
handled by the heuristic and the Reporting API is Chromium-only/server-bound. It lives in
[FUTURE_WORK.md](./FUTURE_WORK.md) with the other deferred items (module-internal growth tracking,
IndexedDB, server upload).

Remaining **v1 launch** work is non-detector: README / usage docs, and the [SPEC §0](./SPEC.md#0-resolved-decisions--open-questions)
open design questions — multi-tab keying, retention, `onCrashRecovered` ack. The non-blocking
`wasDiscarded:true` discard capture stays tracked in SPEC §0 (not gating launch).
