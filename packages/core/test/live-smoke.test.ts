// Live smoke against the real upstream — runs ONLY when LIVE=1 (and .env has
// the UPSTREAM_* values). Under plain `npm test` this file's single test is
// skipped, so the suite never touches the network.
//
// The API key from .env is used only to build the Authorization header: it
// is never logged, asserted on, or written anywhere.
//
// .env is parsed by the shared core helper (env-file.ts) — no dotenv dep.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEnvFile, ProviderAdapter } from "../src/index.js";

// packages/core/test → repo root (where .env lives).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Parsed .env, or {} when the file is missing (skip honestly below). */
function readEnv(): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(join(repoRoot, ".env"), "utf8"));
  } catch {
    return {};
  }
}
const env = readEnv();

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
