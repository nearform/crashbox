import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

// Phase 3: the JS detector + enableDetectors registry. The pure stall-drift helper is tested
// directly; the listener wiring is exercised via happy-dom (node --test isolates this file's
// globals from the plain-Node smoke test). The setInterval watchdog itself is covered by the
// pure helper + the demo, not by faking time here.

/** @type {typeof import("../src/detectors.js")} */
let detectors;

before(async () => {
  const win = new Window({ url: "https://localhost/" });
  const g = /** @type {any} */ (globalThis);
  g.window = win;
  g.Event = win.Event;
  detectors = await import("../src/detectors.js");
});

/**
 * @param {import("../src/types.js").DetectorName[]} names
 * @returns {{ crumbs: Array<{ msg: string, data?: Record<string, unknown> }>, ctx: import("../src/detectors.js").DetectorContext }}
 */
const makeCtx = (names) => {
  /** @type {Array<{ msg: string, data?: Record<string, unknown> }>} */
  const crumbs = [];
  const ctx = {
    /**
     * @param {string} msg
     * @param {Record<string, unknown>} [data]
     */
    breadcrumb: (msg, data) => crumbs.push({ msg, data }),
    options: /** @type {import("../src/types.js").ResolvedOptions} */ ({
      heartbeatMs: 2000,
      breadcrumbLimit: 100,
      snapshotMaxBytes: 32768,
      retentionMs: 604800000,
      detectors: names,
    }),
  };
  return { crumbs, ctx };
};

/** @type {Array<import("../src/detectors.js").Detector>} */
let live = [];
beforeEach(() => {
  for (const d of live) {
    d.stop();
  }
  live = [];
});

// --- stallDriftMs (pure) --------------------------------------------------

test("stallDriftMs: returns lateness past the interval", () => {
  assert.equal(detectors.stallDriftMs(1000, 2500, 1000), 500);
});

test("stallDriftMs: on-time or early ticks report no drift", () => {
  assert.equal(detectors.stallDriftMs(1000, 1900, 1000), 0);
  assert.equal(detectors.stallDriftMs(1000, 2000, 1000), 0);
});

// --- enableDetectors ------------------------------------------------------

test("enableDetectors: js returns one detector with a stop()", () => {
  const { ctx } = makeCtx(["js"]);
  live = detectors.enableDetectors(ctx);
  assert.equal(live.length, 1);
  assert.equal(typeof live[0].stop, "function");
});

test("enableDetectors: an unknown detector name is skipped with a breadcrumb (no throw)", () => {
  const { crumbs, ctx } = makeCtx(
    /** @type {any} */ (["bogus"]), // not in the registry
  );
  live = detectors.enableDetectors(ctx);
  assert.equal(live.length, 0);
  assert.ok(
    crumbs.some((c) => c.data?.signal === "detector-unavailable"),
    "expected a detector-unavailable breadcrumb",
  );
});

test("enableDetectors: all three real detectors enable, none reported unavailable", () => {
  const { crumbs, ctx } = makeCtx(["webgpu", "wasm", "js"]);
  live = detectors.enableDetectors(ctx);
  assert.equal(live.length, 3);
  assert.equal(
    crumbs.filter((c) => c.data?.signal === "detector-unavailable").length,
    0,
  );
});

// --- js detector behavior -------------------------------------------------

test("js detector: an uncaught error becomes a breadcrumb (name folded in for inference)", () => {
  const { crumbs, ctx } = makeCtx(["js"]);
  live = detectors.enableDetectors(ctx);

  const ev = new Event("error");
  Object.assign(ev, {
    message: "too big",
    filename: "app.js",
    lineno: 42,
    error: new RangeError("too big"),
  });
  window.dispatchEvent(ev);

  const crumb = crumbs.find((c) => c.msg.startsWith("js error:"));
  assert.ok(crumb, "expected a js error breadcrumb");
  // The folded-in RangeError name is what classifyReason keys off for "oom".
  assert.match(crumb.msg, /RangeError/);
});

test("js detector: an unhandled rejection becomes a breadcrumb", () => {
  const { crumbs, ctx } = makeCtx(["js"]);
  live = detectors.enableDetectors(ctx);

  const ev = new Event("unhandledrejection");
  Object.assign(ev, { reason: new Error("nope") });
  window.dispatchEvent(ev);

  assert.ok(crumbs.some((c) => c.msg.startsWith("unhandled rejection:")));
});

test("js detector: stop() detaches listeners (no breadcrumbs after)", () => {
  const { crumbs, ctx } = makeCtx(["js"]);
  const handles = detectors.enableDetectors(ctx);
  handles[0].stop();

  const ev = new Event("error");
  Object.assign(ev, { message: "after stop", error: new Error("after stop") });
  window.dispatchEvent(ev);

  assert.equal(
    crumbs.filter((c) => c.msg.startsWith("js error:")).length,
    0,
    "no error breadcrumb should fire after stop()",
  );
});

// --- webgpu detector ------------------------------------------------------
// Hand-rolled fakes (test-only, zero-dep): no real GPUDevice in Node.

class GPUOutOfMemoryError {
  /** @param {string} [message] */
  constructor(message = "") {
    this.message = message;
  }
}
class GPUValidationError {
  /** @param {string} [message] */
  constructor(message = "") {
    this.message = message;
  }
}

const makeFakeDevice = (maxBufferSize = 1024) => {
  /** @type {(info: any) => void} */
  let resolveLost = () => {};
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  return {
    limits: { maxBufferSize },
    lost: new Promise((res) => {
      resolveLost = res;
    }),
    /** @param {string} type @param {Function} fn */
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
    /** @param {string} type @param {Function} fn */
    removeEventListener(type, fn) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((f) => f !== fn),
      );
    },
    /** @param {{ size: number }} descriptor */
    createBuffer(descriptor) {
      return { size: descriptor.size, real: true };
    },
    queue: {
      /** @param {...any} _args */
      writeBuffer(..._args) {},
      /** @param {...any} _args */
      submit(..._args) {},
    },
    /** @param {any} info */
    __resolveLost(info) {
      resolveLost(info);
    },
    /** @param {any} error */
    __emitError(error) {
      (listeners.get("uncapturederror") || []).forEach((f) => f({ error }));
    },
    /** @param {string} type */
    __count(type) {
      return (listeners.get(type) || []).length;
    },
  };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

const makeWebgpuCtx = () => {
  /** @type {Array<{ msg: string, data?: Record<string, unknown> }>} */
  const crumbs = [];
  /** @type {Array<{ reason?: string }>} */
  const imminent = [];
  const ctx = {
    /** @param {string} msg @param {Record<string, unknown>} [data] */
    breadcrumb: (msg, data) => crumbs.push({ msg, data }),
    options: /** @type {import("../src/types.js").ResolvedOptions} */ ({
      heartbeatMs: 2000,
      breadcrumbLimit: 100,
      snapshotMaxBytes: 32768,
      retentionMs: 604800000,
      detectors: ["webgpu"],
      /** @param {{ reason?: string }} info */
      onDeviceLossImminent: (info) => imminent.push(info),
    }),
  };
  return { crumbs, imminent, ctx };
};

test("enableDetectors: webgpu returns a detector exposing attachGPUDevice", () => {
  const { ctx } = makeCtx(["webgpu"]);
  live = detectors.enableDetectors(ctx);
  assert.equal(live.length, 1);
  assert.equal(typeof live[0].attachGPUDevice, "function");
});

test("webgpu: intentional device.destroy is breadcrumbed but NOT a loss signal", async () => {
  const { crumbs, ctx } = makeWebgpuCtx();
  const det = detectors.enableDetectors(ctx)[0];
  live = [det];
  const dev = makeFakeDevice();
  det.attachGPUDevice?.(/** @type {any} */ (dev));
  dev.__resolveLost({ reason: "destroyed", message: "" });
  await tick();
  const crumb = crumbs.find((c) => c.msg.includes("destroyed"));
  assert.ok(crumb);
  assert.notEqual(crumb.data?.signal, "webgpu-device-lost");
});

test("webgpu: unexpected device.lost carries a webgpu-device-lost signal", async () => {
  const { crumbs, ctx } = makeWebgpuCtx();
  const det = detectors.enableDetectors(ctx)[0];
  live = [det];
  const dev = makeFakeDevice();
  det.attachGPUDevice?.(/** @type {any} */ (dev));
  dev.__resolveLost({ reason: "unknown", message: "gpu gone" });
  await tick();
  const crumb = crumbs.find((c) => c.msg.startsWith("webgpu device.lost"));
  assert.ok(crumb);
  assert.equal(crumb.data?.signal, "webgpu-device-lost");
});

test("webgpu: GPUOutOfMemoryError fires onDeviceLossImminent + a loss-signal breadcrumb", () => {
  const { crumbs, imminent, ctx } = makeWebgpuCtx();
  const det = detectors.enableDetectors(ctx)[0];
  live = [det];
  const dev = makeFakeDevice();
  det.attachGPUDevice?.(/** @type {any} */ (dev));
  dev.__emitError(new GPUOutOfMemoryError("budget exceeded"));
  assert.equal(imminent.length, 1);
  assert.equal(imminent[0].reason, "out-of-memory");
  const crumb = crumbs.find((c) => c.msg.includes("GPUOutOfMemoryError"));
  assert.equal(crumb?.data?.signal, "webgpu-device-lost");
});

test("webgpu: a validation error is breadcrumbed but not treated as imminent loss", () => {
  const { crumbs, imminent, ctx } = makeWebgpuCtx();
  const det = detectors.enableDetectors(ctx)[0];
  live = [det];
  const dev = makeFakeDevice();
  det.attachGPUDevice?.(/** @type {any} */ (dev));
  dev.__emitError(new GPUValidationError("size too big"));
  assert.equal(imminent.length, 0);
  const crumb = crumbs.find((c) => c.msg.includes("GPUValidationError"));
  assert.ok(crumb);
  assert.notEqual(crumb.data?.signal, "webgpu-device-lost");
});

test("webgpu: oversized createBuffer warns + delegates to the real createBuffer", () => {
  const { crumbs, imminent, ctx } = makeWebgpuCtx();
  const det = detectors.enableDetectors(ctx)[0];
  live = [det];
  const dev = makeFakeDevice(1024);
  det.attachGPUDevice?.(/** @type {any} */ (dev));
  const buf = /** @type {any} */ (dev).createBuffer({ size: 5000 });
  assert.ok(crumbs.some((c) => c.msg.includes("oversized buffer")));
  assert.equal(imminent[0]?.reason, "oversized-buffer");
  assert.equal(buf.real, true, "must return the real buffer");
});

test("webgpu: stop() restores createBuffer and detaches the error listener", () => {
  const { crumbs, ctx } = makeWebgpuCtx();
  const det = detectors.enableDetectors(ctx)[0];
  const dev = makeFakeDevice(1024);
  det.attachGPUDevice?.(/** @type {any} */ (dev));
  det.stop();
  live = [];
  assert.equal(/** @type {any} */ (dev).__count("uncapturederror"), 0);
  /** @type {any} */ (dev).createBuffer({ size: 999999 });
  assert.equal(
    crumbs.filter((c) => c.msg.includes("oversized")).length,
    0,
    "createBuffer should no longer warn after stop()",
  );
});

// --- webgpu activity log (gap fix) ----------------------------------------

const MB = 1048576;

test("webgpu: a heavy committed burst breadcrumbs a webgpu-device-lost activity marker", () => {
  const { crumbs, ctx } = makeWebgpuCtx();
  const det = detectors.enableDetectors(ctx)[0];
  live = [det];
  const dev = makeFakeDevice();
  det.attachGPUDevice?.(/** @type {any} */ (dev));
  // 2 × 128 MB = 256 MB ≥ burst threshold → immediate flush (no waiting for the timer).
  dev.queue.writeBuffer(null, 0, { byteLength: 128 * MB });
  dev.queue.writeBuffer(null, 0, { byteLength: 128 * MB });
  const crumb = crumbs.find((c) => c.msg.startsWith("webgpu activity"));
  assert.ok(crumb, "expected a gpu activity breadcrumb after a heavy burst");
  assert.equal(crumb.data?.signal, "webgpu-device-lost");
});

test("webgpu: light GPU writes below the pressure floor are not breadcrumbed", () => {
  const { crumbs, ctx } = makeWebgpuCtx();
  const det = detectors.enableDetectors(ctx)[0];
  live = [det];
  const dev = makeFakeDevice();
  det.attachGPUDevice?.(/** @type {any} */ (dev));
  dev.queue.writeBuffer(null, 0, { byteLength: 8 * MB }); // routine write
  assert.equal(
    crumbs.filter((c) => c.msg.startsWith("webgpu activity")).length,
    0,
    "a sub-floor write must not produce an activity breadcrumb",
  );
});

test("webgpu: stop() restores queue.writeBuffer (no activity logging after)", () => {
  const { crumbs, ctx } = makeWebgpuCtx();
  const det = detectors.enableDetectors(ctx)[0];
  const dev = makeFakeDevice();
  det.attachGPUDevice?.(/** @type {any} */ (dev));
  det.stop();
  live = [];
  dev.queue.writeBuffer(null, 0, { byteLength: 512 * MB });
  assert.equal(
    crumbs.filter((c) => c.msg.startsWith("webgpu activity")).length,
    0,
    "no activity breadcrumb should fire after stop()",
  );
});

// --- wasm detector --------------------------------------------------------
// Uses real WebAssembly.Memory (available in Node); the detector patches the global
// WebAssembly.Memory.prototype.grow, so stop() must restore it (beforeEach stops `live`).

const PAGE = 65536; // WASM page = 64 KB
/** @param {number} mb */
const pages = (mb) => Math.ceil((mb * MB) / PAGE);

const makeWasmCtx = () => {
  /** @type {Array<{ msg: string, data?: Record<string, unknown> }>} */
  const crumbs = [];
  let pressure = 0;
  const ctx = {
    /** @param {string} msg @param {Record<string, unknown>} [data] */
    breadcrumb: (msg, data) => crumbs.push({ msg, data }),
    options: /** @type {import("../src/types.js").ResolvedOptions} */ ({
      heartbeatMs: 2000,
      breadcrumbLimit: 100,
      snapshotMaxBytes: 32768,
      retentionMs: 604800000,
      detectors: ["wasm"],
      onMemoryPressure: () => {
        pressure += 1;
      },
    }),
  };
  return { crumbs, pressure: () => pressure, ctx };
};

test("enableDetectors: wasm returns a detector with a stop()", () => {
  const { ctx } = makeCtx(["wasm"]);
  live = detectors.enableDetectors(ctx);
  assert.equal(live.length, 1);
  assert.equal(typeof live[0].stop, "function");
});

test("wasm: a heavy memory grow breadcrumbs memory-near-cap + fires onMemoryPressure", () => {
  const { crumbs, pressure, ctx } = makeWasmCtx();
  live = detectors.enableDetectors(ctx);
  const mem = new WebAssembly.Memory({ initial: 1, maximum: pages(512) });
  mem.grow(pages(300)); // ~300 MB ≥ burst threshold → immediate flush
  const crumb = crumbs.find((c) => c.msg.startsWith("wasm memory:"));
  assert.ok(crumb, "expected a wasm memory breadcrumb after a heavy grow");
  assert.equal(crumb.data?.signal, "memory-near-cap");
  assert.ok(pressure() >= 1, "onMemoryPressure should have fired");
});

test("wasm: a small grow below the floor is not breadcrumbed", () => {
  const { crumbs, ctx } = makeWasmCtx();
  live = detectors.enableDetectors(ctx);
  const mem = new WebAssembly.Memory({ initial: 1, maximum: pages(64) });
  mem.grow(pages(8)); // ~8 MB, below floor
  assert.equal(
    crumbs.filter((c) => c.msg.startsWith("wasm memory:")).length,
    0,
  );
});

test("wasm: a failed grow is breadcrumbed and the RangeError still propagates", () => {
  const { crumbs, ctx } = makeWasmCtx();
  live = detectors.enableDetectors(ctx);
  const mem = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  assert.throws(() => mem.grow(1000), RangeError); // can't exceed maximum
  assert.ok(
    crumbs.some((c) => c.msg.includes("grow failed")),
    "expected a grow-failure breadcrumb",
  );
});

test("wasm: stop() restores WebAssembly.Memory.prototype.grow", () => {
  const { crumbs, ctx } = makeWasmCtx();
  const det = detectors.enableDetectors(ctx)[0];
  det.stop();
  live = [];
  const mem = new WebAssembly.Memory({ initial: 1, maximum: pages(512) });
  mem.grow(pages(300));
  assert.equal(
    crumbs.filter((c) => c.msg.startsWith("wasm memory:")).length,
    0,
    "no wasm breadcrumb should fire after stop()",
  );
});
