// Session identity + storage-key scheme. Keys are namespaced per session so concurrent
// tabs of the same origin don't corrupt each other's inference (the open multi-tab
// gap noted in SPEC §0).

export const KEY_PREFIX = "crashbox";

/** Key holding the id of the current live session (for the next load to find). */
export const CURRENT_SESSION_KEY = `${KEY_PREFIX}:current`;

/**
 * Generate a new session id.
 * @returns {string}
 */
export const newSessionId = () => {
  throw new Error("not implemented"); // Phase 2
};

/**
 * Build the per-session last-gasp key (heartbeat / most-recent crumb / clean-shutdown).
 * @param {string} _sessionId
 * @param {"hb" | "crumb" | "clean"} _kind
 * @returns {string}
 */
export const sessionKey = (_sessionId, _kind) => {
  throw new Error("not implemented"); // Phase 2
};
