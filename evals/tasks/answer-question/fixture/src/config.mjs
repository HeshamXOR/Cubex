export const TIMEOUT_MS = 8000

export const RETRY = {
  /** Wait before the first retry. */
  baseMs: 250,
  /** Every later retry waits this many times as long as the one before it. */
  factor: 3,
  /** No single wait is longer than this. */
  capMs: 5000,
  /** Requests tried in all, the first one included. */
  maxAttempts: 6
}
