// Live smoke against the real upstream — runs ONLY under LIVE=1 with the
// UPSTREAM_* values in the repo-root .env. Under plain `npm test` this file's
// single test is skipped, so the CLI suite never touches the network.
//
// The API key is used only to build the request: it is never logged,
// asserted on, or written anywhere — and the test asserts it never surfaces
// in the answer or the stats block.
//
// .env is parsed by hand (same dialect as the core suite) — no dotenv dep.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatSubCallSummary } from "../src/ask-print.js";
import { runAsk } from "../src/run.js";

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

// packages/cli/test → repo root (where .env lives).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const env = parseEnv(join(repoRoot, ".env"));

const enabled =
  process.env.LIVE === "1" &&
  Boolean(env.UPSTREAM_BASE_URL && env.UPSTREAM_API_KEY && env.UPSTREAM_MODEL);

describe("live smoke (runs only under LIVE=1)", () => {
  it.skipIf(!enabled)('ctxh ask "Say ok" answers via the real upstream', async () => {
    const result = await runAsk({
      question: "Say ok",
      config: {
        upstreamBaseUrl: env.UPSTREAM_BASE_URL!,
        upstreamApiKey: env.UPSTREAM_API_KEY!,
        upstreamModel: env.UPSTREAM_MODEL!,
        dataDir: join(repoRoot, ".ctxh"),
      },
    });
    expect(result.answer.trim().length).toBeGreaterThan(0);
    expect(result.events.length).toBeGreaterThan(0);
    // The key never surfaces — not in the answer, not in the stats block.
    expect(result.answer).not.toContain(env.UPSTREAM_API_KEY!);
    const stats = formatSubCallSummary(result.events).join("\n");
    expect(stats).not.toContain(env.UPSTREAM_API_KEY!);
    expect(stats).toContain("sub-calls: 1");
  });
});
