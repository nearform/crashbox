# crashbox research log

Empirical investigations behind crashbox's design (see [SPEC.md](../work/SPEC.md)). Much of this is
browser-version-specific and undocumented, so each item is validated with a throwaway repro page
(under [`spikes/`](./spikes/)) rather than assumed. Each findings doc records the date, environment
(browser + version + device), method, and the decision the result drove.

## Findings

| #   | Item                                             | Status                                    | Findings                                                         |
| --- | ------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------- |
| 1   | localStorage write durability under OOM kill     | **confirmed (desktop + iOS)**             | [01-localstorage-durability.md](./01-localstorage-durability.md) |
| 2   | iOS tab-discard vs. crash disambiguation         | **discriminator synthesized**             | [02-ios-discard-vs-crash.md](./02-ios-discard-vs-crash.md)       |
| 3   | WebGPU device-loss taxonomy                      | **iOS done**                              | [03-webgpu-device-loss.md](./03-webgpu-device-loss.md)           |
| 4   | GPU-process-kill-takes-tab time budget           | **iOS done** — tab dies, no `device.lost` | [03-webgpu-device-loss.md](./03-webgpu-device-loss.md)           |
| 5   | Reporting API `crash` local ingestion (Chromium) | not investigated (deferred)               | —                                                                |
| 6   | Memory-pressure leading indicators               | **iOS done**                              | [06-memory-pressure.md](./06-memory-pressure.md)                 |
| 7   | Snapshot serialization cost / capability         | desktop done, iOS pending                 | [07-snapshot-serialization.md](./07-snapshot-serialization.md)   |
| 8   | In-browser LLM OOM profile                       | not investigated                          | —                                                                |
| 9   | Black-box size budget under iOS eviction         | not investigated                          | —                                                                |

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
