// Reporting API corroboration (Chromium only) — research §8 #5, low priority. iOS Safari
// has no Reporting API crash payload (research §6 confirmed `ReportingObserver` exists but
// crash-report delivery is Chromium-only), so this only ever *confirms* the heuristic; it
// never carries the inference. Returns the corroborated reason if available, else null.

/**
 * @returns {Promise<{ reason: string } | null>}
 */
export const readCrashReport = async () => {
  throw new Error("not implemented"); // Phase 7
};
