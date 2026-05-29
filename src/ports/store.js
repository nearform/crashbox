// Store port — the durable write path, abstracted so the core is Node-testable.
// The composite adapter writes through to IndexedDB (rich, async) AND a synchronous
// localStorage fallback (last-gasp). Research §8 #1 confirmed the sync localStorage
// write survives a real iOS OOM kill, so it is the trustworthy last-gasp store.

/**
 * One persisted session's black box.
 * @typedef {Object} BlackBoxRecord
 * @property {string} sessionId
 * @property {import("../types.js").Breadcrumb[]} breadcrumbs
 * @property {import("../types.js").Snapshot | undefined} snapshot
 * @property {number} lastSeen           Epoch ms of the last heartbeat.
 * @property {boolean} cleanShutdown     True iff a pagehide{persisted:false} marker was written.
 */

/**
 * @typedef {Object} Store
 * @property {(rec: BlackBoxRecord) => void} put          Persist/replace a session (async, fire-and-forget).
 * @property {(sessionId: string) => Promise<BlackBoxRecord | undefined>} get   Load a session.
 * @property {() => Promise<string | undefined>} previousSessionId  Most-recent prior session id.
 * @property {(sessionId: string) => void} clear          Remove a session after recovery (retention).
 * @property {(key: string, value: string) => void} syncSet  Synchronous last-gasp write (localStorage).
 * @property {(key: string) => string | null} syncGet        Synchronous read.
 */

export {};
