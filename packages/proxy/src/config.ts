// Proxy configuration from the environment.
//
// Precedence, per key: `loadConfig` overrides > real environment variables >
// `.env` file (parsed by hand, no dotenv dependency) > defaults.
//
// Required keys (no defaults): UPSTREAM_BASE_URL, UPSTREAM_API_KEY,
// UPSTREAM_MODEL — a missing one throws a startup error naming the variable
// and pointing at `.env.example`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "@context-hierarchy/core";

/** Context-fitting strategy the proxy's engine runs. */
export type StrategyName = "hierarchy" | "truncation";

/** Fully-resolved proxy configuration (camelCase, env names in comments). */
export interface ProxyConfig {
  /** UPSTREAM_BASE_URL — OpenAI-compatible base URL, version segment included. */
  upstreamBaseUrl: string;
  /** UPSTREAM_API_KEY — forwarded to the upstream, never logged. */
  upstreamApiKey: string;
  /** UPSTREAM_MODEL — every proxied call is routed to this model. */
  upstreamModel: string;
  /** CAP_TOKENS — hard per-model-call token cap (default 6000). */
  capTokens: number;
  /** PORT — listen port; 0 = ephemeral (default 8787). */
  port: number;
  /** STRATEGY — `hierarchy` (default) or `truncation`. */
  strategy: StrategyName;
  /** CONCURRENCY — max concurrent fleet sub-calls per request (default 3). */
  concurrency: number;
  /** DATA_DIR — calibration/spill/distillate/telemetry state (default `.ctxh`). */
  dataDir: string;
  /** PROXY_API_KEY — clients must present this as a Bearer token; empty = no gate. */
  proxyApiKey: string;
}

/**
 * Read the `.env` file at `path` — the shared core parser (blank lines and
 * `#` comments skipped, surrounding whitespace trimmed, matching single/
 * double quotes stripped). A missing file is not an error — it just
 * contributes nothing.
 */
function parseEnvFileAt(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** Parse a non-negative integer env value; absent → `fallback`. */
function intEnv(value: string | undefined, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid value for ${key}: ${JSON.stringify(value)} — expected a non-negative integer.`,
    );
  }
  return parsed;
}

/** Required-string getter: override value or environment/.env value, else throw. */
function requiredEnv(value: string | undefined, key: string): string {
  if (value !== undefined && value !== "") return value;
  throw new Error(
    `Missing required configuration: ${key} is not set. ` +
      `Copy .env.example to .env and fill it in, or export ${key} in the environment.`,
  );
}

/**
 * Load the proxy configuration. `overrides` (a `Partial<ProxyConfig>`) wins
 * over the environment and `.env` for every field it sets. The `.env` file is
 * read from the working directory, and only for keys not already present in
 * the real environment.
 */
export function loadConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  const fileEnv = parseEnvFileAt(join(process.cwd(), ".env"));
  const env = (key: string): string | undefined =>
    process.env[key] !== undefined ? process.env[key] : fileEnv[key];

  const strategy =
    overrides.strategy ?? (env("STRATEGY") as StrategyName | undefined) ?? "hierarchy";
  if (strategy !== "hierarchy" && strategy !== "truncation") {
    throw new Error(
      `Invalid STRATEGY: ${JSON.stringify(strategy)} — expected "hierarchy" or "truncation".`,
    );
  }

  return {
    upstreamBaseUrl: requiredEnv(overrides.upstreamBaseUrl ?? env("UPSTREAM_BASE_URL"), "UPSTREAM_BASE_URL"),
    upstreamApiKey: requiredEnv(overrides.upstreamApiKey ?? env("UPSTREAM_API_KEY"), "UPSTREAM_API_KEY"),
    upstreamModel: requiredEnv(overrides.upstreamModel ?? env("UPSTREAM_MODEL"), "UPSTREAM_MODEL"),
    capTokens: overrides.capTokens ?? intEnv(env("CAP_TOKENS"), "CAP_TOKENS", 6000),
    port: overrides.port ?? intEnv(env("PORT"), "PORT", 8787),
    strategy,
    concurrency: overrides.concurrency ?? intEnv(env("CONCURRENCY"), "CONCURRENCY", 3),
    dataDir: overrides.dataDir ?? env("DATA_DIR") ?? ".ctxh",
    proxyApiKey: overrides.proxyApiKey ?? env("PROXY_API_KEY") ?? "",
  };
}
