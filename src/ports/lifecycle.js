// Lifecycle port — translates browser lifecycle into the two things inference needs:
// a clean-shutdown callback and a snapshot of load-time signals. Abstracted so the
// pure inference logic is Node-testable.
//
// Research §8 #2 (iOS 18.7): write the clean-shutdown marker ONLY on
// `pagehide{persisted:false}` — never on `visibilitychange:hidden` (fires on every
// app-switch) or `pagehide{persisted:true}` (recoverable BFCache park).

/**
 * @typedef {Object} Lifecycle
 * @property {(fn: () => void) => void} onCleanShutdown  Fires on pagehide{persisted:false} only.
 * @property {() => import("../types.js").LoadSignals} readLoadSignals  Load-time signal snapshot.
 */

export {};
