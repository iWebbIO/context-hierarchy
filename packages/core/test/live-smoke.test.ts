// Live smoke against the real upstream — runs ONLY when LIVE=1 (and .env has
// the UPSTREAM_* values). Under plain `npm test` this file's single test is
// skipped, so the suite never touches the network.
//
// The API key from .env is used only to build the Authorization header: it
// is never logged, asserted on, or written anywhere.
//
// .env is parsed by hand with node:fs — no dotenv dependency (per plan).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProviderAdapter } from "../src/index.js";

function parseEnv(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {}; // missing .env → skip honestly below
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
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

// packages/core/test → repo root (where .env lives).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const env = parseEnv(join(repoRoot, ".env"));

const enabled =
  process.env.LIVE === "1" &&
  Boolean(env.UPSTREAM_BASE_URL && env.UPSTREAM_API_KEY && env.UPSTREAM_MODEL);

describe("live smoke (runs only under LIVE=1)", () => {
  it.skipIf(!enabled)(
    "chat() returns a non-empty reply from the upstream",
    async () => {
      const adapter = new ProviderAdapter({
        baseUrl: env.UPSTREAM_BASE_URL!,
        apiKey: env.UPSTREAM_API_KEY!,
      });
      const reply = await adapter.chat({
        model: env.UPSTREAM_MODEL!,
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
      });
      expect(reply.content.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
