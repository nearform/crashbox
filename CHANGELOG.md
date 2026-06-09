# crashbox

## 0.1.0

### Minor Changes

- [#6](https://github.com/nearform/crashbox/pull/6) [`444ba61`](https://github.com/nearform/crashbox/commit/444ba61b19715bdab9fc2685009d826940e8d780) - Budget-relative memory-pressure detection and a visibility-aware hang watchdog.
  - Opt-in `memory` detector reports a leveled `onMemoryPressure({ level, source, ratio, usedBytes, limitBytes })` (nominal/fair/serious/critical).
  - `wasm`/`webgpu` growth thresholds scale to a budget (`memoryBudgetBytes` → `jsHeapSizeLimit` → `navigator.deviceMemory`), with fixed fallbacks when no signal is available.
  - App-supplied signals: `memoryBudgetBytes`, `getMemoryEstimate` (heartbeat pull), and `reportMemoryPressure` (push), with cross-source hysteresis.
  - Hang watchdog ignores backgrounded-tab time, so throttled/suspended timers no longer log false `main-thread stall` hangs.
