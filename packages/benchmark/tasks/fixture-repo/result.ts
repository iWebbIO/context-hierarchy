// qtil: a tiny Result type for explicit error handling without exceptions.

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Wraps a success value. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Wraps a failure reason. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** True when `result` carries a success value. */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/** Returns the value, or throws when `result` holds a failure. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(`unwrap on Err: ${String(result.error)}`);
}
