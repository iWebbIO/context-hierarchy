// qtil: deterministic retry pacing (no jitter — tests rely on exact delays).

/** Backoff delay for attempt `attempt` (0-based), capped at 30 seconds. */
export function delayFor(attempt: number): number {
  if (attempt < 0) {
    throw new RangeError(`attempt must be >= 0, got ${attempt}`);
  }
  return Math.min(500 * 2 ** attempt, 30000);
}

/** Retryable status codes used by the batch pipeline. */
const RETRYABLE = new Set([408, 425, 429, 502, 503, 504]);

/** True when `status` is in the retryable set. */
export function isRetryable(status: number): boolean {
  return RETRYABLE.has(status);
}
