// Shared .env and host helpers — ONE copy for the whole repo (core is the
// only package every other package may depend on, so this lives here).
//
//  - parseEnvFile(text): the manual `KEY=VALUE` .env dialect used by the
//    proxy config, the CLI and the live smoke tests — blank lines and `#`
//    comments skipped, surrounding whitespace trimmed, matching single/double
//    quotes stripped.
//  - readEnvFile(path): parseEnvFile over a file, {} for a missing file.
//  - hostOf(baseUrl): the URL's host for DISPLAY (startup lines, config
//    output, report headers) — "(unparseable host)" when it will not parse.
//    Never a full URL: a URL can carry credentials.

/** Parse `.env`-format text into a KEY→VALUE map (see the module header). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Host of a base URL for display, or a placeholder when unparseable. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "(unparseable host)";
  }
}
