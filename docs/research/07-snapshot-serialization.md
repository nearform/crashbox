# Research 07 — Snapshot serialization cost & capability

> SPEC §8 #7. Status: **in progress** — desktop Chrome done (below); desktop Safari + iOS spot-check
> pending.

## Question

The snapshot deep-clone + size-cap on the persist path must not itself spike memory or block the main
thread — otherwise the instrumentation contributes to the very OOM it's trying to detect. What is the
cost (time + allocation) of `structuredClone` vs `JSON.stringify`, what can each represent, and what
size cap keeps the black box "tiny" (KB, not MB)?

## Method

- Spike page: [`spikes/07-snapshot-serialization.html`](./spikes/07-snapshot-serialization.html) —
  builds representative app-state snapshots at 1 KB / 10 KB / 100 KB / 1 MB and times
  `JSON.stringify`, `structuredClone`, and `JSON.parse(JSON.stringify())` (warm, averaged over
  30–200 iters); runs a capability matrix; calls `measureUserAgentSpecificMemory()`.
- CDP harness: [`spikes/07-driver.mjs`](./spikes/07-driver.mjs) — serves the page with COOP/COEP so
  `crossOriginIsolated === true` (required for `measureUserAgentSpecificMemory`), launches Chrome,
  reads `window.__results`.
- Reproduce: `cd docs/research/spikes && node 07-driver.mjs`.

## Environments to cover

- [x] Desktop Chrome (CDP-driven) — **Chrome 148, macOS** ✅ done
- [ ] Desktop Safari (manual) — version: \_\_\_
- [ ] iOS Safari (manual, iPhone 15 Pro) — iOS: \_\_\_

## Results

### Desktop Chrome 148 (macOS), 2026-05-28 — cost (ms per op, warm)

| JSON size | items | `JSON.stringify` | `structuredClone` | `JSON.parse(JSON.stringify)` |
| --------- | ----- | ---------------- | ----------------- | ---------------------------- |
| ~1 KB     | 9     | 0.0025           | 0.0069            | 0.0062                       |
| ~10 KB    | 76    | 0.014            | 0.052             | 0.040                        |
| ~100 KB   | 732   | 0.099            | 0.472             | 0.348                        |
| ~1 MB     | 7233  | 0.957            | 4.92              | 3.33                         |

- `JSON.stringify` is **~5× faster than `structuredClone`** at every size.
- At the **KB scale where the black box must live, serialization is effectively free** (10 KB ≈
  14 µs). Even 100 KB is 0.1 ms; only a 1 MB snapshot approaches ~1 ms (JSON) / ~5 ms (clone).
- `measureUserAgentSpecificMemory()` worked under COOP/COEP (≈1.57 MB baseline);
  `performance.memory` is present on Chrome.

### Capability matrix

| value            | `structuredClone`           | `JSON` round-trip      |
| ---------------- | --------------------------- | ---------------------- |
| typed array      | **preserved**               | lossy → `{"0":1,...}`  |
| cyclic reference | **preserved**               | **throws** `TypeError` |
| function         | **throws** `DataCloneError` | silently dropped       |
| `Date`           | preserved                   | → ISO string           |
| `undefined`      | preserved                   | dropped                |
| `Map`            | preserved                   | → `{}`                 |

## Interpretation

- The **localStorage last-gasp fallback can only carry strings → JSON**. structuredClone's extra
  fidelity (typed arrays, cycles, Map) can't survive that path anyway, so there's no point requiring
  it end-to-end.
- JSON is both the **cheaper and the more portable** choice. Its sharp edges (cycles throw, functions
  dropped) are acceptable for an app _state snapshot_ and easy to guard.

## Decision this drives

- **Snapshot contract (resolves the SPEC §0 open item):** the snapshot must be **JSON-serializable**.
  `setSnapshot` JSON-serializes defensively (try/catch; on `TypeError`/cycle, reject + breadcrumb a
  warning rather than throw into the app). No `structuredClone` dependency in the core.
- **Size cap:** enforce a JSON **byte cap in the low tens of KB** (default ~16–32 KB pending §8 #9
  iOS eviction budget). At that size, serialization is sub-50 µs — no measurable hot-path cost.
- **No Worker needed** for the persist path at KB scale; main-thread JSON is sub-millisecond. Revisit
  only if a consumer needs MB-scale snapshots (out of scope for the tiny black box).
- `src/blackbox/snapshot.js`: `JSON.stringify` + byte-length cap + try/catch; store the string in
  both IDB and the localStorage fallback.
