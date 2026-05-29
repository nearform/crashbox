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

test("enableDetectors: unimplemented detector is skipped with a breadcrumb (no throw)", () => {
  const { crumbs, ctx } = makeCtx(["webgpu"]);
  live = detectors.enableDetectors(ctx);
  assert.equal(live.length, 0);
  assert.ok(
    crumbs.some((c) => c.data?.signal === "detector-unavailable"),
    "expected a detector-unavailable breadcrumb",
  );
});

test("enableDetectors: mixed list enables js, notes the unimplemented one", () => {
  const { crumbs, ctx } = makeCtx(["js", "wasm"]);
  live = detectors.enableDetectors(ctx);
  assert.equal(live.length, 1);
  assert.equal(
    crumbs.filter((c) => c.data?.signal === "detector-unavailable").length,
    1,
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
