// qtil: CSV cell handling for single lines (no multi-line records).

/** Splits one CSV line on commas that are outside double-quoted spans. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/** Joins cells into one CSV line, quoting cells that contain commas. */
export function toCsvLine(cells: string[]): string {
  return cells.map((c) => (c.includes(",") ? `"${c}"` : c)).join(",");
}
