// Live proxy smoke test — runs ONLY under LIVE=1 (and .env having the
// UPSTREAM_* values). Under plain `npm test` this file's single test is
// skipped, so the suite never touches the network.
//
// It boots the REAL proxy (startProxy, ephemeral port) and makes one small
// real chat-completions request via plain fetch against the local URL. The
// upstream API key from .env is used only to reach the upstream; it is never
// logged, asserted on, or written anywhere.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseEnvFile } from "@context-hierarchy/core";
import { loadConfig, startProxy } from "../src/index.js";

// packages/proxy/test → repo root (where .env lives).
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

let server: { url: string; close(): Promise<void> } | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("live proxy smoke (runs only under LIVE=1)", () => {
  it.skipIf(!enabled)(
    "startProxy serves one small real chat completion (200 + assistant content)",
    async () => {
      tempDir = mkdtempSync(join(tmpdir(), "ctxh-live-proxy-"));
      const cfg = loadConfig({
        port: 0, // ephemeral
        dataDir: tempDir,
      });
      server = await startProxy(cfg);
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const res = await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "any-model-name",
          messages: [{ role: "user", content: "Reply with the single word: pong" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        choices: Array<{ message: { role: string; content: string } }>;
      };
      expect(body.choices[0].message.role).toBe("assistant");
      expect(body.choices[0].message.content.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
