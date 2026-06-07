A JavaScript library for a local-first browser crash "black box" that survives hard tab kills
(WebGPU, WASM, in-browser OOM) and surfaces the recovered state on next load. Types are JSDoc
annotations validated by `tsc` (no transpile). Prioritize robust persistence/recovery logic and a
clean, configurable API.

The authoritative contributor notes — architecture, commands, the zero-runtime-dependency and
supply-chain policy, and the demo (`index.html`) stack constraints — are in
[`AGENTS.md`](../AGENTS.md). Follow it.
