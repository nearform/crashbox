# crashbox — design map

How the `src/` modules map to the research findings ([docs/research/](./research/)) and the
implementation phases. The scaffold (Phase 0) is in place as typed stubs; each module's header
comment cites the finding that drives it.

## Architecture: ports & adapters

The pure core depends only on **ports** (`src/ports/*` — `Store`, `Clock`, `Lifecycle` typedefs), so
it is testable under `node --test` with fakes. Browser glue lives in **adapters** (`src/adapters/*`),
the only files touching `window`/`localStorage`/`indexedDB`/`GPUDevice`. This is what lets the
load-bearing logic (ring buffer, inference, discard heuristic) run in Node while the platform code is
isolated.

## Module → finding → phase

| Module                       | Role                      | Research finding                                                           | Phase    |
| ---------------------------- | ------------------------- | -------------------------------------------------------------------------- | -------- |
| `index.js`                   | Public API (SPEC §5)      | —                                                                          | 0 (done) |
| `types.js`                   | JSDoc typedef hub         | —                                                                          | 0 (done) |
| `blackbox/ring.js`           | breadcrumb ring buffer    | allocation-light hot path (§2)                                             | 1        |
| `blackbox/throttle.js`       | coalescing flush          | don't cause the OOM you detect (§2)                                        | 1        |
| `blackbox/snapshot.js`       | JSON serialize + byte cap | #7 — JSON, ~16–32 KB, no structuredClone                                   | 1        |
| `blackbox/recorder.js`       | hot-path facade           | §2                                                                         | 2        |
| `inference/classify.js`      | reason inference          | #1/#4 — GPU+WASM OOM both hard-kill, reason from tail                      | 1        |
| `inference/discard.js`       | discard-vs-crash guard    | #2 — `wasDiscarded` suppressor; clean only on `pagehide{persisted:false}`  | 1        |
| `inference/recover.js`       | next-load orchestration   | #1/#2                                                                      | 2        |
| `inference/reporting-api.js` | Chromium corroboration    | #5 — iOS has none; confirm-only                                            | 7        |
| `adapters/local-store.js`    | sync last-gasp store      | #1 — sync localStorage survives real iOS OOM                               | 3        |
| `adapters/idb-store.js`      | rich async store          | #1                                                                         | 3        |
| `heartbeat.js`               | liveness timestamp        | #2 — short age ≠ no-crash; for time-of-death only                          | 2        |
| `detectors/js.js`            | onerror/rejection/hang    | #6 — no `longtask` on iOS → watchdog                                       | 3        |
| `detectors/webgpu.js`        | GPU device wrap           | #3/#4 — `GPUOutOfMemoryError` precedes kill; `device.lost` only on destroy | 5        |
| `detectors/wasm.js`          | WASM memory growth        | #6 — only memory signal on iOS → `onMemoryPressure`                        | 6        |

## Phase order

0 toolchain + scaffold (done) → 1 pure core (Node-tested) → 2 ports + orchestration → 3 browser
adapters + JS detector + demo harness → 5 WebGPU → 6 WASM → 7 Reporting API + iOS hardening. See the
approved plan and [SPEC §0](./SPEC.md#0-resolved-decisions--open-questions) for resolved decisions and
remaining open design questions (multi-tab keying, retention, `onCrashRecovered` ack).
