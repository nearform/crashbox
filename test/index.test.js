import { test } from "node:test";
import assert from "node:assert/strict";
import {
  init,
  breadcrumb,
  setSnapshot,
  attachGPUDevice,
  getActiveOptions,
  DEFAULTS,
} from "../src/index.js";

// Phase 0 smoke test: the public API surface exists, is callable, and option
// resolution works. Behavior (persistence/detection/inference) is tested in Phases 1+.

test("public API is callable and exported", () => {
  assert.equal(typeof init, "function");
  assert.equal(typeof breadcrumb, "function");
  assert.equal(typeof setSnapshot, "function");
  assert.equal(typeof attachGPUDevice, "function");
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

test("breadcrumb / setSnapshot / attachGPUDevice are safe no-ops in Phase 0", () => {
  init();
  assert.doesNotThrow(() => breadcrumb("hello", { a: 1 }));
  assert.doesNotThrow(() => breadcrumb("no-data"));
  assert.doesNotThrow(() => setSnapshot({ counter: 1 }));
});
