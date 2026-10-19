// qtil: small standalone string helpers. No dependencies.

/** Lowercases the input, then uppercases the first letter of every word. */
export function titleCase(input: string): string {
  return input
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Slug for filenames and URLs: lowercase, non-alphanumerics to "-". */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Cuts to `max` characters, appending the marker when trimming happened. */
export function truncate(input: string, max: number, marker = "..."): string {
  if (max < 0) {
    throw new RangeError(`max must be >= 0, got ${max}`);
  }
  if (input.length <= max) {
    return input;
  }
  const keep = Math.max(0, max - marker.length);
  return input.slice(0, keep) + marker;
}
