// qtil: unit formatting and range clamping.

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** Formats bytes with one decimal and binary (1024) steps, e.g. "1.5 MiB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`bytes must be a finite non-negative number, got ${bytes}`);
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${UNITS[unit]}`;
}

/** Clamps `value` into [min, max]; throws when the bounds are inverted. */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`min must be <= max, got ${min} > ${max}`);
  }
  return Math.min(Math.max(value, min), max);
}
