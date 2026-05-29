// WASM detector — wraps WebAssembly.Memory to track linear-memory growth as the OOM
// leading indicator, and traps RangeError/abort. Research §6: on iOS Safari there is NO
// browser memory API (no performance.memory / measureUserAgentSpecificMemory), so WASM
// `Memory.grow` tracking is the ONLY memory-pressure signal available → it drives
// `onMemoryPressure`. The OOM kill itself takes the tab with no event (Layer-3 inference).

/**
 * @param {import("./registry.js").DetectorContext} _ctx
 * @returns {import("./registry.js").Detector}
 */
export const createWasmDetector = (_ctx) => {
  throw new Error("not implemented"); // Phase 6
};
