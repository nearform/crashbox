# `crashbox`

Local-first crash black box for the browser: survives hard tab kills (WebGPU,
WASM, in-browser LLM OOM) and surfaces the recovered state on next load.

## Status

Pre-implementation. Design and research are tracked in [`docs/`](./docs/):

- [`docs/SPEC.md`](./docs/SPEC.md) — specification & handoff (architecture, public API, demo).
- [`docs/research/`](./docs/research/) — empirical research log for the load-bearing assumptions
  (localStorage durability under OOM, iOS discard-vs-crash, snapshot cost).

TODO: usage docs once the v1 spine lands.
