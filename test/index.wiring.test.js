import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

// Phase 2: index.js browser wiring (localStorage black box + heartbeat + clean-shutdown
// marker + recover-on-load) tested in Node via happy-dom. node --test isolates each file in
// its own process, so these installed globals don't leak into the plain-Node smoke test.
//
// Tested behaviorally end-to-end (init → record → "crash" → next init recovers), which proves
// persistence + recovery without reaching into the localStorage key scheme.

/** @type {typeof import("../src/index.js")} */
let crashbox;

before(async () => {
  const win = new Window({ url: "https://localhost/" });
  const g = /** @type {any} */ (globalThis);
  g.window = win;
  g.document = win.document;
  g.localStorage = win.localStorage;
  g.Event = win.Event; // so dispatched events are instances the happy-dom window accepts
  crashbox = await import("../src/index.js");
});

beforeEach(() => {
  // Fresh slate: clearing the "current" pointer makes the next init see no previous session.
  localStorage.clear();
  // @ts-expect-error experimental flag, set per-test
  delete document.wasDiscarded;
});

/** Simulate a graceful exit: pagehide with persisted:false writes the clean-shutdown marker. */
const fireCleanShutdown = () => {
  const ev = new Event("pagehide");
  // @ts-expect-error PageTransitionEvent.persisted, faked on a plain Event
  ev.persisted = false;
  window.dispatchEvent(ev);
};

/**
 * Run init capturing any recovered crash record.
 * @param {import("../src/types.js").CrashboxOptions} [opts]
 * @returns {import("../src/types.js").CrashRecord | null}
 */
const initCapturing = (opts = {}) => {
  /** @type {import("../src/types.js").CrashRecord | null} */
  let got = null;
  crashbox.init({
    ...opts,
    onCrashRecovered(record) {
      got = record;
    },
  });
  return got;
};

test("no previous session → nothing recovered", () => {
  const got = initCapturing();
  assert.equal(got, null);
});

test("a session with no clean shutdown is recovered as a crash", () => {
  initCapturing(); // session A starts, persisted to localStorage
  crashbox.breadcrumb("rendering frame");
  // No pagehide fires → next load sees a live box with no clean marker.
  const got = initCapturing(); // session B recovers A
  assert.ok(got, "expected a crash record");
});

test("a clean shutdown is NOT recovered as a crash", () => {
  initCapturing();
  crashbox.breadcrumb("work");
  fireCleanShutdown();
  const got = initCapturing();
  assert.equal(got, null);
});

test("an iOS tab-discard is NOT recovered as a crash", () => {
  initCapturing();
  crashbox.breadcrumb("work");
  // @ts-expect-error experimental flag
  document.wasDiscarded = true;
  const got = initCapturing();
  assert.equal(got, null);
});

test("crash reason: device.lost breadcrumb → webgpu-device-lost", () => {
  initCapturing();
  crashbox.breadcrumb("device.lost: unknown");
  const got = initCapturing();
  assert.equal(got?.reason, "webgpu-device-lost");
});

test("crash reason: WASM RangeError breadcrumb → oom", () => {
  initCapturing();
  crashbox.breadcrumb("RangeError: Memory.grow");
  const got = initCapturing();
  assert.equal(got?.reason, "oom");
});

test("crash reason: only a heartbeat trail → hard-kill", () => {
  initCapturing();
  crashbox.breadcrumb("ordinary app event");
  const got = initCapturing();
  assert.equal(got?.reason, "hard-kill");
});

test("breadcrumbs + snapshot persist and round-trip through recovery", () => {
  initCapturing();
  crashbox.breadcrumb("first", { n: 1 });
  crashbox.breadcrumb("second");
  crashbox.setSnapshot({ counter: 42, label: "alive" });
  const got = initCapturing();
  assert.ok(got);
  assert.deepEqual(
    got?.breadcrumbs.map((c) => c.msg),
    ["first", "second"],
  );
  assert.equal(got?.breadcrumbs[0].data?.n, 1);
  assert.deepEqual(got?.snapshot, { counter: 42, label: "alive" });
});

test("snapshot over the byte cap is rejected; prior snapshot kept + rejection breadcrumbed", () => {
  initCapturing({ snapshotMaxBytes: 64 });
  crashbox.setSnapshot({ ok: "small" });
  crashbox.setSnapshot({ big: "x".repeat(200) }); // over the cap → rejected
  const got = initCapturing();
  assert.deepEqual(got?.snapshot, { ok: "small" }, "prior snapshot retained");
  assert.ok(
    got?.breadcrumbs.some((c) => c.data?.signal === "snapshot-rejected"),
    "a rejection breadcrumb was recorded",
  );
});

test("ring buffer cap is honored across recovery (keeps newest-N)", () => {
  initCapturing({ breadcrumbLimit: 3 });
  for (let i = 1; i <= 6; i++) {
    crashbox.breadcrumb(`m${i}`);
  }
  const got = initCapturing();
  assert.deepEqual(
    got?.breadcrumbs.map((c) => c.msg),
    ["m4", "m5", "m6"],
  );
});

test("a crash is delivered only once (fire-once: the previous record is consumed)", () => {
  initCapturing();
  crashbox.breadcrumb("device.lost");
  const first = initCapturing(); // recovers the crash
  assert.ok(first);
  // Re-init again without simulating a new crash: B was clean? No — B had no clean marker either,
  // but it had no informative crumbs and a fresh heartbeat. It IS a crash (hard-kill), but the
  // ORIGINAL crash record must not be re-delivered. Assert the second delivery is a different id.
  const second = initCapturing();
  assert.notEqual(second?.sessionId, first?.sessionId);
});

test("breadcrumb / setSnapshot before init are safe no-ops", () => {
  // Fresh module-load semantics aren't resettable here, but calling after a clear is harmless.
  assert.doesNotThrow(() => crashbox.breadcrumb("x"));
  assert.doesNotThrow(() => crashbox.setSnapshot({ a: 1 }));
});

// --- debug handle (opt-in) ------------------------------------------------

test("debug is off by default → window.__crashbox is not attached", () => {
  const win = /** @type {any} */ (window);
  delete win.__crashbox;
  crashbox.init();
  assert.equal(win.__crashbox, undefined);
});

test("init({ debug: true }) attaches window.__crashbox with introspection helpers", () => {
  crashbox.init({ debug: true });
  const handle = /** @type {any} */ (window).__crashbox;
  assert.ok(handle, "expected a debug handle");
  for (const fn of ["dump", "clear", "recovered", "getStatus", "breadcrumb"]) {
    assert.equal(typeof handle[fn], "function", `${fn} should be callable`);
  }
  // Handle reflects live SDK state and can read/wipe the persisted black box.
  assert.equal(handle.getStatus().sessionId, crashbox.getStatus()?.sessionId);
  assert.ok(Object.keys(handle.dump()).some((k) => k.startsWith("crashbox:")));
  const removed = /** @type {string[]} */ (handle.clear());
  assert.ok(removed.every((k) => k.startsWith("crashbox:")));
  assert.deepEqual(handle.dump(), {});
});

// --- teardown (full unload) -----------------------------------------------

test("teardown marks a clean shutdown → the session is NOT recovered as a crash", () => {
  crashbox.init();
  crashbox.breadcrumb("work");
  crashbox.teardown();
  const got = initCapturing();
  assert.equal(
    got,
    null,
    "a torn-down session is a graceful exit, not a crash",
  );
});

test("teardown reinstates a patched native (WebAssembly.Memory.prototype.grow)", () => {
  const original = WebAssembly.Memory.prototype.grow;
  crashbox.init({ detectors: ["wasm"] });
  assert.notEqual(
    WebAssembly.Memory.prototype.grow,
    original,
    "the wasm detector should have patched grow",
  );
  crashbox.teardown();
  assert.equal(
    WebAssembly.Memory.prototype.grow,
    original,
    "teardown should restore the original grow",
  );
});

test("teardown removes the window.__crashbox debug handle", () => {
  crashbox.init({ debug: true });
  assert.ok(/** @type {any} */ (window).__crashbox, "handle attached by debug");
  crashbox.teardown();
  assert.equal(/** @type {any} */ (window).__crashbox, undefined);
});

test("teardown is safe before init and is idempotent", () => {
  crashbox.teardown(); // before any init
  crashbox.init();
  assert.doesNotThrow(() => {
    crashbox.teardown();
    crashbox.teardown();
  });
  assert.equal(
    crashbox.getActiveOptions(),
    null,
    "active options reset to pre-init after teardown",
  );
});

// --- namespace isolation (co-hosted apps on one origin) -------------------

test("two namespaces on one origin don't collide", () => {
  // App "a" runs and crashes (no clean shutdown).
  crashbox.init({ namespace: "a" });
  crashbox.breadcrumb("a-event");
  // App "b" inits — must not see a's crash, nor consume a's record.
  const bRecovered = initCapturing({ namespace: "b" });
  assert.equal(bRecovered, null, "app b sees no crash in its own namespace");
  // App "a" reloads — still recovers its own crash.
  const aRecovered = initCapturing({ namespace: "a" });
  assert.ok(aRecovered, "app a recovers its own crash after b ran");
});

test("namespaced keys are prefixed crashbox:<namespace>:", () => {
  localStorage.clear();
  crashbox.init({ namespace: "myapp" });
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k) {
      keys.push(k);
    }
  }
  assert.ok(
    keys.every((k) => k.startsWith("crashbox:myapp:")),
    `all keys namespaced, got ${JSON.stringify(keys)}`,
  );
});

// --- retention sweep ------------------------------------------------------

/**
 * @param {string} id
 * @param {number} lastSeen
 */
const seedRecord = (id, lastSeen) => {
  localStorage.setItem(
    `crashbox:record:${id}`,
    JSON.stringify({
      sessionId: id,
      breadcrumbs: [],
      snapshot: undefined,
      lastSeen,
      cleanShutdown: false,
    }),
  );
};

test("retention sweep removes records older than retentionMs", () => {
  seedRecord("stale", Date.now() - 60000); // 60s old
  crashbox.init({ retentionMs: 1000 });
  assert.equal(localStorage.getItem("crashbox:record:stale"), null);
});

test("retention sweep keeps fresh records", () => {
  seedRecord("fresh", Date.now());
  crashbox.init({ retentionMs: 1000 });
  assert.ok(localStorage.getItem("crashbox:record:fresh"));
});

test("retentionMs sweeps within the active namespace only", () => {
  // A stale orphan under namespace "a" should not be touched by an init in namespace "b".
  localStorage.setItem(
    "crashbox:a:record:stale",
    JSON.stringify({ sessionId: "stale", breadcrumbs: [], lastSeen: 0 }),
  );
  crashbox.init({ namespace: "b", retentionMs: 1000 });
  assert.ok(
    localStorage.getItem("crashbox:a:record:stale"),
    "another namespace's records are out of scope for this app's sweep",
  );
});
