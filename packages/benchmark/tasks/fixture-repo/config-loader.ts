// qtil: loads a small config object with defaults and light validation.

export interface ConfigOptions {
  retries: number;
  timeoutMs: number;
  encoding: string;
}

/** Defaults applied when the source object omits a key. */
const DEFAULTS: ConfigOptions = {
  retries: 4,
  timeoutMs: 45000,
  encoding: "utf-8",
};

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Merges `source` over DEFAULTS, then `overrides` over that. */
export function loadConfig(
  source: Record<string, unknown> = {},
  overrides: Partial<ConfigOptions> = {},
): ConfigOptions {
  const merged: ConfigOptions = { ...DEFAULTS };
  if (isPositiveInt(source["retries"])) {
    merged.retries = source["retries"];
  }
  if (isPositiveInt(source["timeoutMs"])) {
    merged.timeoutMs = source["timeoutMs"];
  }
  if (typeof source["encoding"] === "string" && source["encoding"] !== "") {
    merged.encoding = source["encoding"];
  }
  if (overrides.retries !== undefined) {
    merged.retries = overrides.retries;
  }
  if (overrides.timeoutMs !== undefined) {
    merged.timeoutMs = overrides.timeoutMs;
  }
  if (overrides.encoding !== undefined) {
    merged.encoding = overrides.encoding;
  }
  return merged;
}
