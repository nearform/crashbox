---
"crashbox": minor
---

Budget-relative memory-pressure detection and a visibility-aware hang watchdog.

- Opt-in `memory` detector reports a leveled `onMemoryPressure({ level, source, ratio, usedBytes, limitBytes })` (nominal/fair/serious/critical).
- `wasm`/`webgpu` growth thresholds scale to a budget (`memoryBudgetBytes` → `jsHeapSizeLimit` → `navigator.deviceMemory`), with fixed fallbacks when no signal is available.
- App-supplied signals: `memoryBudgetBytes`, `getMemoryEstimate` (heartbeat pull), and `reportMemoryPressure` (push), with cross-source hysteresis.
- Hang watchdog ignores backgrounded-tab time, so throttled/suspended timers no longer log false `main-thread stall` hangs.
