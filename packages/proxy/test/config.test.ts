// Config unit tests (task-6 brief R2): env → ProxyConfig with the exact
// defaults, required-key errors naming the variable, manual `.env` parsing,
// and override merging. Environment mutation is safe here: vitest isolates
// each test file in its own worker.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/index.js";

const REQUIRED_ENV = {
  UPSTREAM_BASE_URL: "https://upstream.example/v1",
  UPSTREAM_API_KEY: "test-key",
  UPSTREAM_MODEL: "test-model",
} as const;

const dirs: string[] = [];
const savedCwd = process.cwd();
const savedEnv = { ...process.env };

/** Set the three required vars (and nothing else optional) in process.env. */
function setRequiredEnv(): void {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value;
}

/** Remove every key the proxy reads, from process.env. */
function clearProxyEnv(): void {
  for (const key of [
    ...Object.keys(REQUIRED_ENV),
    "CAP_TOKENS",
    "PORT",
    "STRATEGY",
    "CONCURRENCY",
    "DATA_DIR",
    "PROXY_API_KEY",
  ]) {
    delete process.env[key];
  }
}

/** Temp working directory containing a `.env` with the given contents. */
function withDotEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxh-config-test-"));
  writeFileSync(join(dir, ".env"), contents, "utf8");
  dirs.push(dir);
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  process.chdir(savedCwd);
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  // Restore the environment the file started with (other tests may rely on it).
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("loadConfig", () => {
  it("fills every default from .env.example and reads required keys from env", () => {
    clearProxyEnv();
    setRequiredEnv();
    const cfg = loadConfig();
    expect(cfg).toEqual({
      upstreamBaseUrl: "https://upstream.example/v1",
      upstreamApiKey: "test-key",
      upstreamModel: "test-model",
      capTokens: 6000,
      port: 8787,
      strategy: "hierarchy",
      concurrency: 3,
      dataDir: ".ctxh",
      proxyApiKey: "",
    });
  });

  it("reads optional keys from the environment (truncation strategy, custom numbers)", () => {
    clearProxyEnv();
    setRequiredEnv();
    process.env.STRATEGY = "truncation";
    process.env.CAP_TOKENS = "2048";
    process.env.PORT = "9000";
    process.env.CONCURRENCY = "5";
    process.env.DATA_DIR = "state";
    process.env.PROXY_API_KEY = "gate-key";
    expect(loadConfig()).toMatchObject({
      strategy: "truncation",
      capTokens: 2048,
      port: 9000,
      concurrency: 5,
      dataDir: "state",
      proxyApiKey: "gate-key",
    });
  });

  it("parses .env by hand when the vars are not already in the environment", () => {
    clearProxyEnv();
    withDotEnv(
      [
        "# comment line",
        "UPSTREAM_BASE_URL=https://file.example/v1",
        "UPSTREAM_API_KEY=file-key",
        "UPSTREAM_MODEL=file-model",
        "CAP_TOKENS=1234",
        'DATA_DIR="quoted dir"',
        "EMPTY_IGNORED_LINE_NO_EQUALS_SHOULD_BE_SKIPPED",
        "PROXY_API_KEY=",
      ].join("\n"),
    );
    const cfg = loadConfig();
    expect(cfg.upstreamBaseUrl).toBe("https://file.example/v1");
    expect(cfg.upstreamApiKey).toBe("file-key");
    expect(cfg.upstreamModel).toBe("file-model");
    expect(cfg.capTokens).toBe(1234);
    expect(cfg.dataDir).toBe("quoted dir");
    expect(cfg.proxyApiKey).toBe("");
  });

  it("prefers real environment variables over .env values", () => {
    clearProxyEnv();
    withDotEnv("UPSTREAM_BASE_URL=https://file.example/v1\nUPSTREAM_API_KEY=file-key\nUPSTREAM_MODEL=file-model\nPORT=1111\n");
    process.env.UPSTREAM_API_KEY = "env-key-wins";
    process.env.PORT = "2222";
    const cfg = loadConfig();
    expect(cfg.upstreamApiKey).toBe("env-key-wins");
    expect(cfg.port).toBe(2222);
    expect(cfg.upstreamBaseUrl).toBe("https://file.example/v1"); // only in .env
  });

  it("a missing required key throws a startup error naming the env var and .env.example", () => {
    // Run in a temp cwd with NO .env — the repo's real .env (which has the
    // values) must not mask the missing-key path.
    withDotEnv("");
    clearProxyEnv();
    process.env.UPSTREAM_BASE_URL = REQUIRED_ENV.UPSTREAM_BASE_URL;
    process.env.UPSTREAM_API_KEY = REQUIRED_ENV.UPSTREAM_API_KEY;
    // UPSTREAM_MODEL deliberately absent everywhere.
    expect(() => loadConfig()).toThrow(/UPSTREAM_MODEL/);
    expect(() => loadConfig()).toThrow(/\.env\.example/);
  });

  it("an invalid STRATEGY value is rejected", () => {
    clearProxyEnv();
    setRequiredEnv();
    process.env.STRATEGY = "map-reduce";
    expect(() => loadConfig()).toThrow(/STRATEGY/);
  });

  it("a non-numeric CAP_TOKENS is rejected", () => {
    clearProxyEnv();
    setRequiredEnv();
    process.env.CAP_TOKENS = "many";
    expect(() => loadConfig()).toThrow(/CAP_TOKENS/);
  });

  it("overrides merge over everything (programmatic startProxy path)", () => {
    clearProxyEnv();
    setRequiredEnv();
    process.env.CAP_TOKENS = "6000";
    const cfg = loadConfig({
      port: 0, // ephemeral
      capTokens: 42,
      dataDir: "custom-dir",
      strategy: "truncation",
      proxyApiKey: "p",
    });
    expect(cfg).toMatchObject({
      port: 0,
      capTokens: 42, // override wins over env
      dataDir: "custom-dir",
      strategy: "truncation",
      proxyApiKey: "p",
      upstreamModel: "test-model", // untouched fields fall through to env
    });
  });
});
