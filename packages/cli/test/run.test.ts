// CLI tests (brief R5) — NO network, ever.
//
// The ask paths run the REAL stack (loadConfig → buildEngineStack →
// FleetEngine → TokenAccountant → strategy) over a scripted FakeAdapter
// injected through buildEngineStack's adapter seam — the same pattern the
// core suite uses (`as unknown as ProviderAdapter`, required because
// ProviderAdapter is nominal). main() is driven through an injectable IO
// plus an injectable runAsk (the proxy's buildServer DI pattern), so what
// would print and the exit codes are asserted without a model or a server.
//
// All config-facing tests pin every loadConfig field via overrides so they
// are deterministic regardless of the machine's .env / environment.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FleetEngine,
  TokenAccountant,
  UpstreamError,
} from "@context-hierarchy/core";
import type {
  ChatParams,
  ChatResult,
  ProviderAdapter,
  StreamEvent,
  SubCallEvent,
} from "@context-hierarchy/core";
import type { ProxyConfig, StrategyName } from "@context-hierarchy/proxy";
import { formatSubCallSummary } from "../src/ask-print.js";
import { buildEngineStack } from "../src/engine-stack.js";
import {
  formatConfig,
  main,
  parseArgs,
  runAsk,
  UsageError,
} from "../src/run.js";

/** A fresh temp data dir per use (calibration/spill state; removed after). */
function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "ctxh-cli-"));
}

/** Fake upstream values for loadConfig overrides — never a real endpoint. */
function fakeOverrides(dataDir: string): Partial<ProxyConfig> {
  return {
    upstreamBaseUrl: "https://upstream.invalid/v1",
    upstreamApiKey: "sk-cli-never-print-this-key",
    upstreamModel: "cli-test-model",
    capTokens: 4000,
    strategy: "truncation",
    dataDir,
  };
}

/** Recording scripted adapter (structural fake; cast at the injection site). */
class FakeAdapter {
  readonly calls: ChatParams[] = [];
  constructor(private readonly script: (params: ChatParams) => ChatResult) {}
  async chat(params: ChatParams): Promise<ChatResult> {
    this.calls.push(params);
    return this.script(params);
  }
  async *stream(params: ChatParams): AsyncGenerator<StreamEvent> {
    this.calls.push(params);
    yield { type: "finish", finishReason: "stop" };
  }
}

/** The cast the nominal ProviderAdapter type forces (same as core's suite). */
function asAdapter(fake: FakeAdapter): ProviderAdapter {
  return fake as unknown as ProviderAdapter;
}

/** Capturing IO so tests assert exactly what would print. */
function captureIo(): { out: (line: string) => void; err: (line: string) => void; lines: { out: string[]; err: string[] } } {
  const lines = { out: [] as string[], err: [] as string[] };
  return {
    out: (line) => lines.out.push(line),
    err: (line) => lines.err.push(line),
    lines,
  };
}

// ---------------------------------------------------------------------------
// parseArgs (R5d)
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses serve with --port", () => {
    expect(parseArgs(["serve", "--port", "3000"])).toEqual({
      command: "serve",
      port: 3000,
      stats: false,
    });
  });

  it("parses the --port=N inline form", () => {
    expect(parseArgs(["serve", "--port=0"])).toEqual({
      command: "serve",
      port: 0,
      stats: false,
    });
  });

  it("parses a quoted question with ask flags", () => {
    expect(
      parseArgs(["ask", "what is the meaning of life?", "--cap", "500", "--model", "m2", "--stats"]),
    ).toEqual({
      command: "ask",
      question: "what is the meaning of life?",
      cap: 500,
      model: "m2",
      stats: true,
    });
  });

  it("accepts flags before the command", () => {
    expect(parseArgs(["--stats", "ask", "hi"])).toEqual({
      command: "ask",
      question: "hi",
      stats: true,
    });
  });

  it("no args → no command (help path)", () => {
    expect(parseArgs([])).toEqual({ stats: false });
  });

  it("throws UsageError on an unknown flag", () => {
    expect(() => parseArgs(["ask", "hi", "--bogus"])).toThrow(UsageError);
    expect(() => parseArgs(["ask", "hi", "--bogus"])).toThrow(/unknown flag: --bogus/);
  });

  it("throws UsageError on a non-integer port", () => {
    expect(() => parseArgs(["serve", "--port", "abc"])).toThrow(/--port .*non-negative integer/);
  });

  it("throws UsageError on a missing flag value", () => {
    expect(() => parseArgs(["serve", "--port"])).toThrow(/missing value for --port/);
  });

  it("throws UsageError on an unknown command", () => {
    expect(() => parseArgs(["fly"])).toThrow(/unknown command: fly/);
  });

  it("throws UsageError when ask has no question", () => {
    expect(() => parseArgs(["ask"])).toThrow(/ask requires a question/);
  });

  it("throws UsageError when ask gets more than one positional", () => {
    expect(() => parseArgs(["ask", "one", "two"])).toThrow(/exactly one question/);
  });

  it("throws UsageError when serve/config/help get positionals", () => {
    expect(() => parseArgs(["config", "extra"])).toThrow(/takes no positional/);
  });
});

// ---------------------------------------------------------------------------
// formatConfig — the config mask (R5c)
// ---------------------------------------------------------------------------

describe("formatConfig", () => {
  const full: ProxyConfig = {
    upstreamBaseUrl: "https://apix.example.com/v1",
    upstreamApiKey: "sk-super-secret-key-value",
    upstreamModel: "some-model",
    capTokens: 6000,
    port: 8787,
    strategy: "hierarchy",
    concurrency: 3,
    dataDir: ".ctxh",
    proxyApiKey: "proxy-secret-also-never-printed",
  };

  it("shows the host but never the API keys or the full URL", () => {
    const out = formatConfig(full).join("\n");
    expect(out).toContain("apix.example.com");
    expect(out).toContain("upstream api key: set");
    expect(out).toContain("proxy api key: set");
    // The key strings themselves must never appear.
    expect(out).not.toContain(full.upstreamApiKey);
    expect(out).not.toContain(full.proxyApiKey);
    // Host only: no path, no scheme, no full URL.
    expect(out).not.toContain("https://apix.example.com/v1");
    expect(out).not.toContain("/v1");
  });

  it("masks an unset key as unset and resolves the data dir", () => {
    const out = formatConfig({ ...full, upstreamApiKey: "", dataDir: ".ctxh" }).join("\n");
    expect(out).toContain("upstream api key: unset");
    expect(out).toMatch(/data dir: .*[\\/]\.ctxh$/); // resolved to an absolute path
  });
});

// ---------------------------------------------------------------------------
// formatSubCallSummary (R5b) — labels, tokens, latency, flags
// ---------------------------------------------------------------------------

describe("formatSubCallSummary", () => {
  it("formats one compact line per sub-call", () => {
    const events: SubCallEvent[] = [
      { call: "direct", estimatedTokens: 9, promptTokens: 12, completionTokens: 3, latencyMs: 118, cacheHit: false },
      { call: "worker", estimatedTokens: 210, latencyMs: 1432, cacheHit: true },
      { call: "synthesizer", estimatedTokens: 640, latencyMs: 2210, cacheHit: false, degraded: true },
    ];
    const lines = formatSubCallSummary(events);
    expect(lines[0]).toBe("sub-calls: 3");
    expect(lines[1]).toContain("1. direct");
    expect(lines[1]).toContain("9t");
    expect(lines[1]).toContain("12+3t actual");
    expect(lines[1]).toContain("118ms");
    expect(lines[2]).toContain("2. worker");
    expect(lines[2]).toContain("210t");
    expect(lines[2]).toContain("cache-hit");
    expect(lines[2]).not.toContain("actual"); // no usage was reported
    expect(lines[3]).toContain("3. synthesizer");
    expect(lines[3]).toContain("degraded");
  });

  it("still reports zero sub-calls", () => {
    expect(formatSubCallSummary([])).toEqual(["sub-calls: 0"]);
  });
});

// ---------------------------------------------------------------------------
// buildEngineStack (R3)
// ---------------------------------------------------------------------------

describe("buildEngineStack", () => {
  it("wires a real FleetEngine and collects its sub-call events", async () => {
    const dataDir = tmpDataDir();
    try {
      const fake = new FakeAdapter(() => ({
        content: "ok",
        finishReason: "stop",
      }));
      const stack = buildEngineStack({
        baseUrl: "https://upstream.invalid/v1",
        apiKey: "k",
        model: "cli-test-model",
        capTokens: 1000,
        dataDir,
        strategy: "hierarchy",
        adapter: asAdapter(fake),
      });
      expect(stack.engine).toBeInstanceOf(FleetEngine);
      const result = await stack.engine.run({
        model: "cli-test-model",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.content).toBe("ok");
      expect(stack.events).toHaveLength(1);
      expect(stack.events[0].call).toBe("direct");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown strategy name", () => {
    expect(() =>
      buildEngineStack({
        baseUrl: "https://upstream.invalid/v1",
        apiKey: "k",
        model: "m",
        capTokens: 1000,
        dataDir: tmpDataDir(),
        strategy: "bogus" as StrategyName,
      }),
    ).toThrow(/Unknown strategy/);
  });
});

// ---------------------------------------------------------------------------
// runAsk — ask end-to-end through the real stack over a scripted fake (R5a)
// ---------------------------------------------------------------------------

describe("runAsk", () => {
  it("runs the question through the stack and returns the scripted answer", async () => {
    const dataDir = tmpDataDir();
    try {
      const fake = new FakeAdapter(() => ({
        content: "The answer is 42.",
        finishReason: "stop",
        usage: { promptTokens: 12, completionTokens: 5 },
      }));
      const result = await runAsk({
        question: "What is the answer?",
        config: fakeOverrides(dataDir),
        adapter: asAdapter(fake),
      });
      expect(result.answer).toBe("The answer is 42.");
      expect(result.degraded).toBe(false);
      // One direct sub-call, with the usage the upstream reported.
      expect(result.events).toHaveLength(1);
      expect(result.events[0].call).toBe("direct");
      expect(result.events[0].promptTokens).toBe(12);
      // Exactly one upstream call: the question as the sole user message.
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].model).toBe("cli-test-model");
      expect(fake.calls[0].messages).toEqual([{ role: "user", content: "What is the answer?" }]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("enforces the cap on an oversized question — the dispatched messages are fitted, never over cap", async () => {
    const dataDir = tmpDataDir();
    const CAP = 2000;
    try {
      let seen: ChatParams | undefined;
      const fake = new FakeAdapter((params) => {
        seen = params;
        return { content: "ok", finishReason: "stop" }; // no usage → no calibration drift
      });
      const question = `Summarize this document: ${"lorem ipsum dolor sit amet ".repeat(1000)}`;
      const result = await runAsk({
        question,
        config: { ...fakeOverrides(dataDir), capTokens: CAP },
        adapter: asAdapter(fake),
      });
      expect(result.answer).toBe("ok");
      // A single user message over the cap degenerates the fleet into one
      // fitted synthesizer call — the cap is enforced through the CLI stack.
      expect(result.events).toHaveLength(1);
      expect(result.events[0].call).toBe("synthesizer");
      expect(fake.calls).toHaveLength(1);
      expect(seen).toBeDefined();
      const estimate = new TokenAccountant({ dataDir }).estimate(seen!.messages, "cli-test-model");
      expect(estimate).toBeLessThanOrEqual(CAP);
      // The truncation fit middle-cut the question (elision marker present).
      expect(seen!.messages.some((m) => m.content.includes("elided"))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("propagates upstream errors with their message (the exit-1 path)", async () => {
    const dataDir = tmpDataDir();
    try {
      const fake = new FakeAdapter(() => {
        throw new UpstreamError("upstream exploded", 500);
      });
      await expect(
        runAsk({
          question: "q",
          config: fakeOverrides(dataDir),
          adapter: asAdapter(fake),
        }),
      ).rejects.toThrow(/upstream exploded/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// main — dispatch, printing, exit codes (usage paths + scripted ask)
// ---------------------------------------------------------------------------

describe("main", () => {
  it("no args prints usage on stdout and exits 0", async () => {
    const io = captureIo();
    const code = await main([], io);
    expect(code).toBe(0);
    expect(io.lines.out.join("\n")).toContain("Usage:");
    expect(io.lines.err).toHaveLength(0);
  });

  it("help prints usage and exits 0", async () => {
    const io = captureIo();
    const code = await main(["help"], io);
    expect(code).toBe(0);
    expect(io.lines.out.join("\n")).toContain("ctxh serve");
    expect(io.lines.out.join("\n")).toContain("ctxh ask");
  });

  it("an unknown flag prints the message + usage on stderr and exits 2", async () => {
    const io = captureIo();
    const code = await main(["ask", "hi", "--bogus"], io);
    expect(code).toBe(2);
    const err = io.lines.err.join("\n");
    expect(err).toContain("unknown flag: --bogus");
    expect(err).toContain("Usage:");
    expect(io.lines.out).toHaveLength(0);
  });

  it("an unknown command exits 2", async () => {
    const io = captureIo();
    expect(await main(["fly"], io)).toBe(2);
    expect(io.lines.err.join("\n")).toContain("unknown command: fly");
  });

  it("ask prints the answer, then the --stats sub-call summary, and exits 0", async () => {
    const io = captureIo();
    const events: SubCallEvent[] = [
      { call: "direct", estimatedTokens: 9, promptTokens: 12, completionTokens: 3, latencyMs: 118, cacheHit: false },
    ];
    let captured: { question?: string; capTokens?: number; model?: string } | undefined;
    const code = await main(["ask", "What is the answer?", "--cap", "500", "--model", "m2", "--stats"], io, {
      runAsk: async (opts) => {
        captured = opts;
        return { answer: "The answer is 42.", degraded: false, events };
      },
    });
    expect(code).toBe(0);
    // The flags reached runAsk.
    expect(captured).toEqual({
      question: "What is the answer?",
      capTokens: 500,
      model: "m2",
    });
    // What would print: the answer line, then the stats block.
    expect(io.lines.out[0]).toBe("The answer is 42.");
    const stats = io.lines.out.slice(1).join("\n");
    expect(stats).toContain("sub-calls: 1");
    expect(stats).toContain("1. direct");
    expect(stats).toContain("9t");
    expect(stats).toContain("118ms");
    expect(io.lines.err).toHaveLength(0);
  });

  it("ask notes a degraded answer on stderr but still exits 0", async () => {
    const io = captureIo();
    const code = await main(["ask", "hi"], io, {
      runAsk: async () => ({
        answer: "partial",
        degraded: true,
        events: [{ call: "direct", estimatedTokens: 5, latencyMs: 10, cacheHit: false, degraded: true }],
      }),
    });
    expect(code).toBe(0);
    expect(io.lines.out[0]).toBe("partial");
    expect(io.lines.err.join("\n")).toContain("degraded");
  });

  it("ask maps an upstream error to the message on stderr and exit 1", async () => {
    const io = captureIo();
    const code = await main(["ask", "hi"], io, {
      runAsk: async () => {
        throw new UpstreamError("upstream exploded", 500);
      },
    });
    expect(code).toBe(1);
    const err = io.lines.err.join("\n");
    expect(err).toContain("upstream exploded");
    expect(io.lines.out).toHaveLength(0);
  });
});
