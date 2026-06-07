import { test } from "node:test";
import assert from "node:assert/strict";
import {
  init,
  teardown,
  breadcrumb,
  setSnapshot,
  attachGPUDevice,
  getActiveOptions,
  wrap,
  DEFAULTS,
} from "../src/index.js";

// Smoke test: the public API surface exists, is callable, and option resolution
// works. Behavior (persistence/detection/inference) is covered in the other test files.

test("public API is callable and exported", () => {
  assert.equal(typeof init, "function");
  assert.equal(typeof breadcrumb, "function");
  assert.equal(typeof setSnapshot, "function");
  assert.equal(typeof attachGPUDevice, "function");
  assert.equal(typeof teardown, "function");
});

test("getActiveOptions is null before init", () => {
  assert.equal(getActiveOptions(), null);
});

test("init resolves defaults and merges overrides", () => {
  init();
  assert.deepEqual(getActiveOptions(), DEFAULTS);

  init({ heartbeatMs: 500, detectors: ["webgpu", "js"] });
  const opts = getActiveOptions();
  assert.equal(opts?.heartbeatMs, 500);
  assert.deepEqual(opts?.detectors, ["webgpu", "js"]);
  // untouched defaults remain
  assert.equal(opts?.breadcrumbLimit, DEFAULTS.breadcrumbLimit);
  assert.equal(opts?.snapshotMaxBytes, DEFAULTS.snapshotMaxBytes);
});

test("breadcrumb / setSnapshot / attachGPUDevice are safe no-ops in a non-browser context", () => {
  init();
  assert.doesNotThrow(() => breadcrumb("hello", { a: 1 }));
  assert.doesNotThrow(() => breadcrumb("no-data"));
  assert.doesNotThrow(() => setSnapshot({ counter: 1 }));
});

test("wrap: success path resolves and yields the inner value", async () => {
  init();
  const result = await wrap("work", async () => 42);
  assert.equal(result, 42);
});

test("wrap: error path re-throws the original error", async () => {
  init();
  const boom = new Error("boom");
  await assert.rejects(
    () =>
      wrap("work", async () => {
        throw boom;
      }),
    /boom/,
  );
});

test("wrap: makeData is only invoked once and lazily", async () => {
  init();
  let calls = 0;
  const makeData = () => {
    calls += 1;
    return { call: calls };
  };
  await wrap("work", async () => 1, makeData);
  assert.equal(calls, 1);
});

test("attachGPUDevice is exported and callable (no-op without webgpu detector)", () => {
  init();
  assert.doesNotThrow(() => attachGPUDevice(/** @type {any} */ ({})));
});
