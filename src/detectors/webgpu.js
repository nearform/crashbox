// WebGPU detector — primary v1 target. Wraps a GPUDevice (via attachGPUDevice). Research
// §8 #3/#4 (iOS 18.7) findings drive the design:
//   - device.lost reason "destroyed" = intentional (not a crash); any other reason = loss.
//   - A real GPU OOM HARD-KILLS the tab with NO device.lost — caught by Layer-3 inference,
//     not here. But a `GPUOutOfMemoryError` (via uncapturederror) fires seconds beforehand
//     → that is the actionable `onDeviceLossImminent` signal.
//   - Oversized buffers surface as GPUValidationError (device survives); compare requested
//     sizes to adapter `maxBufferSize` proactively rather than waiting for a throw.
//   - adapter.info is {} on iOS — no GPU fingerprint; don't branch on it.

/**
 * @param {import("./registry.js").DetectorContext} _ctx
 * @returns {import("./registry.js").Detector & { attach: (device: GPUDevice) => void }}
 */
export const createWebGpuDetector = (_ctx) => {
  throw new Error("not implemented"); // Phase 5
};
