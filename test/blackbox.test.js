import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RingBuffer,
  serializeSnapshot,
  parseSnapshot,
} from "../src/blackbox.js";

// Phase 1: the pure black box. Ring buffer fill/overflow/order, and JSON snapshot
// serialize/cap + parse round-trips — all directly under node --test, no browser.

/**
 * @param {number} t
 * @returns {import("../src/types.js").Breadcrumb}
 */
const crumb = (t) => ({ t, msg: `c${t}` });

test("RingBuffer: empty buffer yields []", () => {
  const rb = new RingBuffer(3);
  assert.deepEqual(rb.toArray(), []);
  assert.equal(rb.size, 0);
});

test("RingBuffer: fills in insertion order until full", () => {
  const rb = new RingBuffer(3);
  rb.push(crumb(1));
  rb.push(crumb(2));
  assert.deepEqual(
    rb.toArray().map((c) => c.t),
    [1, 2],
  );
  assert.equal(rb.size, 2);
  rb.push(crumb(3));
  assert.deepEqual(
    rb.toArray().map((c) => c.t),
    [1, 2, 3],
  );
  assert.equal(rb.size, 3);
});

test("RingBuffer: overflow drops the oldest, keeps newest-N oldest→newest", () => {
  const rb = new RingBuffer(3);
  for (let t = 1; t <= 5; t++) {
    rb.push(crumb(t));
  }
  // 1 and 2 dropped; 3,4,5 remain oldest→newest.
  assert.deepEqual(
    rb.toArray().map((c) => c.t),
    [3, 4, 5],
  );
  assert.equal(rb.size, 3);
  assert.equal(rb.capacity, 3);
});

test("RingBuffer: order stays correct across multiple wraps", () => {
  const rb = new RingBuffer(3);
  for (let t = 1; t <= 10; t++) {
    rb.push(crumb(t));
  }
  assert.deepEqual(
    rb.toArray().map((c) => c.t),
    [8, 9, 10],
  );
});

test("RingBuffer: capacity 1 keeps only the latest", () => {
  const rb = new RingBuffer(1);
  rb.push(crumb(1));
  rb.push(crumb(2));
  assert.deepEqual(
    rb.toArray().map((c) => c.t),
    [2],
  );
  assert.equal(rb.size, 1);
});

test("RingBuffer: degenerate capacity 0 is a safe no-op", () => {
  const rb = new RingBuffer(0);
  assert.doesNotThrow(() => rb.push(crumb(1)));
  assert.deepEqual(rb.toArray(), []);
  assert.equal(rb.size, 0);
});

test("RingBuffer: toArray returns a copy, not the live backing store", () => {
  const rb = new RingBuffer(3);
  rb.push(crumb(1));
  const snap = rb.toArray();
  snap.push(crumb(99));
  assert.deepEqual(
    rb.toArray().map((c) => c.t),
    [1],
  );
});

test("serializeSnapshot: round-trips a JSON-safe object under the cap", () => {
  const state = { counter: 3, items: ["a", "b"], nested: { ok: true } };
  const json = serializeSnapshot(state, 1024);
  assert.equal(typeof json, "string");
  assert.deepEqual(parseSnapshot(json), state);
});

test("serializeSnapshot: returns null when over maxBytes", () => {
  const state = { blob: "x".repeat(100) };
  assert.equal(serializeSnapshot(state, 16), null);
});

test("serializeSnapshot: caps on UTF-8 byte length, not character count", () => {
  // JSON is `{"v":"€€€€"}` — 12 chars but 20 UTF-8 bytes (each € is 3 bytes).
  const state = { v: "€€€€" };
  // A char-count cap would accept 15; a correct byte cap rejects it.
  assert.equal(serializeSnapshot(state, 15), null);
  assert.equal(serializeSnapshot(state, 20), '{"v":"€€€€"}');
});

test("serializeSnapshot: returns null on a cyclic structure (no throw)", () => {
  /** @type {Record<string, unknown>} */
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(serializeSnapshot(cyclic, 1024), null);
});

test("serializeSnapshot: returns null on BigInt (JSON.stringify throws)", () => {
  // BigInt is a `Record<string, unknown>`-valid value to TS but makes JSON.stringify throw.
  assert.equal(serializeSnapshot({ n: 1n }, 1024), null);
});

test("parseSnapshot: returns undefined for absent input", () => {
  assert.equal(parseSnapshot(undefined), undefined);
  assert.equal(parseSnapshot(null), undefined);
  assert.equal(parseSnapshot(""), undefined);
});

test("parseSnapshot: returns undefined for invalid JSON (no throw)", () => {
  assert.equal(parseSnapshot("{not json"), undefined);
});

test("parseSnapshot: parses a valid JSON object", () => {
  assert.deepEqual(parseSnapshot('{"a":1}'), { a: 1 });
});
