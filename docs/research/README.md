# crashbox research log

Empirical investigations from [SPEC §8](../SPEC.md#8-research-directions-for-claude-code-open-questions-to-investigate).
Much of this is browser-version-specific and undocumented, so each item is validated with a
throwaway repro page (under [`spikes/`](./spikes/)) rather than assumed. Findings docs record the
date, environment (browser + version + device), method, and the decision the result drives.

## Status

| #   | Item                                             | Risk                                              | Status                    | Findings                                                         |
| --- | ------------------------------------------------ | ------------------------------------------------- | ------------------------- | ---------------------------------------------------------------- |
| 1   | localStorage write durability under OOM kill     | **highest** — Layer 1 fallback rests on it        | desktop done, iOS pending | [01-localstorage-durability.md](./01-localstorage-durability.md) |
| 2   | iOS tab-discard vs. crash disambiguation         | **high** — false-positive guard on primary target | todo                      | [02-ios-discard-vs-crash.md](./02-ios-discard-vs-crash.md)       |
| 7   | Snapshot serialization cost / capability         | high — must not cause the OOM it detects          | desktop done, iOS pending | [07-snapshot-serialization.md](./07-snapshot-serialization.md)   |
| 3   | WebGPU device-loss taxonomy                      | med — gates WebGPU detector (Phase 5)             | not started               | —                                                                |
| 4   | GPU-process-kill-takes-tab time budget           | med                                               | not started               | —                                                                |
| 5   | Reporting API `crash` local ingestion (Chromium) | low — corroboration only                          | not started               | —                                                                |
| 6   | Memory-pressure leading indicators               | med — drives `onMemoryPressure`                   | not started               | —                                                                |
| 8   | In-browser LLM OOM profile (flagship)            | high — real-world validation                      | not started               | —                                                                |
| 9   | Black-box size budget under iOS eviction         | med — sets default limits                         | not started               | —                                                                |

## Current focus (pre-implementation spikes)

Items **1, 7, 2** are the load-bearing assumptions and run _before_ any SDK code:

- **Spike 1 / 7** — desktop Chrome runs driven via Chrome CDP (automated); desktop Safari + iOS
  Safari + iOS PWA runs are manual on real hardware (iPhone 15 Pro).
- **Spike 2** — manual iOS runs only (no CDP on device); data collection starts early since it's the
  longest-lead, highest false-positive risk.

## Running the spikes

**Desktop Chrome (automated, CDP):**

```sh
cd docs/research/spikes
node 01-driver.mjs --mode crash --runs 3   # localStorage/IDB durability under renderer kill
node 01-driver.mjs --mode oom              # real allocation-driven kill attempt
node 07-driver.mjs                         # snapshot serialization cost + capability
```

Each launches a throwaway Chrome (isolated `--user-data-dir` under `/tmp`) and prints JSON.

**iPhone 15 Pro (manual, over LAN):** start the LAN server on a MacBook, open the printed URL on the
phone (same Wi-Fi), run the scenario, and copy the on-screen JSON back.

```sh
cd docs/research/spikes
node serve.mjs            # prints http://<lan-ip>:8080/<spike>.html
```

- **Spike 1 (`01-localstorage-durability.html`):** tap "Start write loop + induce OOM", let the tab
  die, reopen the URL, copy the "Recovered from previous run" JSON. Also do it from an
  add-to-homescreen PWA. The page can't observe its own out-of-process high-water n, so note the
  largest `n` shown on screen before death as the reference.
- **Spike 2 (`02-ios-discard-vs-crash.html`):** run scenarios A–E from
  [02-ios-discard-vs-crash.md](./02-ios-discard-vs-crash.md); copy the "THIS LOAD" JSON each time.
- **Spike 7 (`07-snapshot-serialization.html`):** loads and prints `window.__results`; copy it
  (cross-browser cost spot-check vs. Chrome).

## Environment legend

Record per run: browser + exact version, device (e.g. `iPhone 15 Pro, iOS 18.x`), and whether it was
a Safari tab vs. add-to-homescreen PWA.
