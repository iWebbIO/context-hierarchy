// qtil: date formatting helpers over plain Date objects (UTC only).

/** Two-digit zero-padded number, e.g. pad2(7) === "07". */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Formats a Date using {YYYY} {MM} {DD} {hh} {mm} {ss} template tokens. */
export function formatDate(date: Date, template: string): string {
  return template
    .replaceAll("{YYYY}", String(date.getUTCFullYear()).padStart(4, "0"))
    .replaceAll("{MM}", pad2(date.getUTCMonth() + 1))
    .replaceAll("{DD}", pad2(date.getUTCDate()))
    .replaceAll("{hh}", pad2(date.getUTCHours()))
    .replaceAll("{mm}", pad2(date.getUTCMinutes()))
    .replaceAll("{ss}", pad2(date.getUTCSeconds()));
}

/** True for Gregorian leap years. */
export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && year % 100 !== 0;
}

/** Days in `month` (1-12) of `year`; throws on out-of-range months. */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) {
    throw new RangeError(`month must be 1-12, got ${month}`);
  }
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

/** Parses "YYYY-MM-DDThh:mm:ssZ" into a UTC Date; null when malformed. */
export function parseIsoDate(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(text);
  if (!match) {
    return null;
  }
  const [y, mo, d, h, mi, s] = match.slice(1).map((p) => Number(p));
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Reject impossible dates such as Feb 30 by round-tripping the month.
  return date.getUTCMonth() === mo - 1 ? date : null;
}
