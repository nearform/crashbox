// Detectors — enrichment, not the crash catch (hard kills have no live event; the crash
// itself is caught by inference on the next load). Each detector observes its source, drops
// breadcrumbs, and fires early-warning callbacks. Enabled per `options.detectors` (default
// ["js"]; webgpu/wasm opt-in). Kept in one file — inline-able since they share a tiny shape.
//
// Research-driven specifics:
//  - js: onerror + onunhandledrejection. iOS Safari has NO PerformanceObserver 'longtask'
//        (research §6) → hang detection uses a main-thread watchdog (setInterval drift).
//  - webgpu: wrap GPUDevice. device.lost reason "destroyed" = intentional; a real GPU OOM
//        hard-kills with NO device.lost, but emits GPUOutOfMemoryError (uncapturederror)
//        seconds before → that fires onDeviceLossImminent (research §8 #3/#4).
//  - wasm: track WebAssembly.Memory growth — the ONLY memory-pressure signal on iOS
//        (research §6: no performance.memory / measureUserAgentSpecificMemory) → onMemoryPressure.

/**
 * @typedef {Object} DetectorContext
 * @property {(msg: string, data?: Record<string, unknown>) => void} breadcrumb
 * @property {import("./types.js").ResolvedOptions} options
 */

/**
 * @typedef {Object} Detector
 * @property {() => void} stop
 * @property {(device: GPUDevice) => void} [attachGPUDevice]
 */

/**
 * Enable the detectors named in ctx.options.detectors. Returns handles for teardown +
 * GPU-device attachment.
 * @param {DetectorContext} _ctx
 * @returns {Detector[]}
 */
export const enableDetectors = (_ctx) => {
  throw new Error("not implemented"); // Phase 3 (js) / 5 (webgpu) / 6 (wasm)
};
