import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countTokens, TokenAccountant } from "../src/index.js";
import type { ChatMessage } from "../src/index.js";

// All accountant tests run against a throwaway dataDir under os.tmpdir() —
// never the repo's .ctxh.
let dir = "";

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), "ctxh-core-test-"));
  return dir;
}

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

const hello: ChatMessage = { role: "user", content: "hello world" }; // 2 tokens
const toolMessage: ChatMessage = {
  role: "assistant",
  content: "hello world", // 2 tokens
  tool_calls: [
    {
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Paris"}' }, // 5 tokens
    },
  ],
};

describe("TokenAccountant.estimate", () => {
  it("adds per-message overhead and applies the default margin exactly", () => {
    const accountant = new TokenAccountant({ dataDir: freshDir() });
    // One "hello world" message: raw = 2 + 4 = 6; ceil(6 * 1.15) = 7.
    expect(accountant.estimate([hello])).toBe(7);
    // Two messages: raw = 12; ceil(12 * 1.15) = 14.
    expect(accountant.estimate([hello, { ...hello, role: "assistant" }])).toBe(14);
  });

  it("charges 3 + arguments tokens per tool call", () => {
    const accountant = new TokenAccountant({ dataDir: freshDir() });
    // raw = (2 + 4) + (3 + 5) = 14; ceil(14 * 1.15) = 17.
    expect(accountant.estimate([toolMessage])).toBe(17);
  });

  it("grows with message count", () => {
    const accountant = new TokenAccountant({ dataDir: freshDir() });
    const msgs: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hello world" },
      { role: "user", content: "The quick brown fox jumps over the lazy dog." },
    ];
    const one = accountant.estimate([msgs[0]]);
    const two = accountant.estimate([msgs[0], msgs[1]]);
    const three = accountant.estimate(msgs);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
  });

  it("estimate >= raw count, and margin 1 yields the raw count exactly", () => {
    const exact = new TokenAccountant({ dataDir: freshDir(), margin: 1 });
    const defaultMargin = new TokenAccountant({ dataDir: freshDir() });
    const msgs = [hello, toolMessage, { role: "system", content: "You are a helpful assistant." }];

    // Independent raw computation: ceil(tokens(content)) + 4 per message,
    // + 3 + ceil(tokens(arguments)) per tool call.
    const raw = msgs.reduce(
      (sum, m) =>
        sum +
        Math.ceil(countTokens(m.content)) +
        4 +
        (m.tool_calls?.reduce(
          (s, c) => s + 3 + Math.ceil(countTokens(c.function.arguments)),
          0,
        ) ?? 0),
      0,
    );
    // raw = 6 + 14 + 10 = 30
    expect(raw).toBe(30);
    expect(exact.estimate(msgs)).toBe(raw);
    expect(defaultMargin.estimate(msgs)).toBe(Math.ceil(raw * 1.15)); // 35
    expect(defaultMargin.estimate(msgs)).toBeGreaterThanOrEqual(raw);
  });

  it("returns 0 for an empty message list", () => {
    const accountant = new TokenAccountant({ dataDir: freshDir() });
    expect(accountant.estimate([])).toBe(0);
  });
});

describe("TokenAccountant calibration", () => {
  it("unknown model has factor 1.0", () => {
    const accountant = new TokenAccountant({ dataDir: freshDir() });
    expect(accountant.factorFor("never-observed")).toBe(1.0);
  });

  it("observeUsage converges the factor upward toward actual/estimated", () => {
    const accountant = new TokenAccountant({ dataDir: freshDir() });
    // ratio 1.5: 1.0 -> 0.75*1.0 + 0.25*1.5 = 1.125
    accountant.observeUsage("m-up", 100, 150);
    const first = accountant.factorFor("m-up");
    expect(first).toBe(1.125);
    expect(first).toBeGreaterThan(1.0);
    expect(first).toBeLessThan(1.5);

    accountant.observeUsage("m-up", 100, 150);
    const second = accountant.factorFor("m-up");
    expect(second).toBeGreaterThan(first);

    for (let i = 0; i < 30; i++) accountant.observeUsage("m-up", 100, 150);
    expect(accountant.factorFor("m-up")).toBeCloseTo(1.5, 3);
  });

  it("observeUsage converges the factor downward and floors at 0.5", () => {
    const accountant = new TokenAccountant({ dataDir: freshDir() });
    // ratio 0.4 (< floor): EMA falls from 1.0 and clamps at 0.5.
    accountant.observeUsage("m-down", 100, 40);
    const first = accountant.factorFor("m-down");
    expect(first).toBeLessThan(1.0);
    for (let i = 0; i < 10; i++) accountant.observeUsage("m-down", 100, 40);
    expect(accountant.factorFor("m-down")).toBe(0.5);
  });

  it("caps the factor at 3.0", () => {
    const accountant = new TokenAccountant({ dataDir: freshDir() });
    // ratio 10: 0.75*1.0 + 0.25*10 = 3.25 -> clamped 3.0.
    accountant.observeUsage("m-cap", 100, 1000);
    expect(accountant.factorFor("m-cap")).toBe(3.0);
  });

  it("a calibrated factor scales the estimate", () => {
    const accountant = new TokenAccountant({ dataDir: freshDir() });
    accountant.observeUsage("cal-model", 100, 150); // factor 1.125
    // raw 6 * 1.15 * 1.125 = 7.7625 -> 8
    expect(accountant.estimate([hello], "cal-model")).toBe(8);
  });

  it("skips updates with no defined ratio (estimated <= 0) instead of poisoning the factor", () => {
    const accountant = new TokenAccountant({ dataDir: freshDir() });
    accountant.observeUsage("m-zero", 0, 100);
    expect(accountant.factorFor("m-zero")).toBe(1.0);
  });
});

describe("TokenAccountant persistence", () => {
  it("round-trips factors through a new instance on the same dataDir", () => {
    const dataDir = freshDir();
    const first = new TokenAccountant({ dataDir });
    first.observeUsage("persist-model", 100, 150); // 1.125
    expect(existsSync(join(dataDir, "calibration.json"))).toBe(true);

    const second = new TokenAccountant({ dataDir });
    expect(second.factorFor("persist-model")).toBe(1.125);

    const onDisk = JSON.parse(readFileSync(join(dataDir, "calibration.json"), "utf8"));
    expect(onDisk["persist-model"]).toBe(1.125);
  });

  it("tolerates a corrupt calibration file (fresh start, never throws)", () => {
    const dataDir = freshDir();
    writeFileSync(join(dataDir, "calibration.json"), "{not json at all", "utf8");

    const accountant = new TokenAccountant({ dataDir });
    expect(accountant.factorFor("any")).toBe(1.0);
    expect(accountant.estimate([hello])).toBe(7);

    // observing again rewrites the file as valid JSON.
    accountant.observeUsage("m-recover", 100, 150);
    const onDisk = JSON.parse(readFileSync(join(dataDir, "calibration.json"), "utf8"));
    expect(onDisk["m-recover"]).toBe(1.125);
  });

  it("ignores non-numeric entries but keeps valid ones", () => {
    const dataDir = freshDir();
    writeFileSync(
      join(dataDir, "calibration.json"),
      '{"bad":"fast","good":1.5}',
      "utf8",
    );
    const accountant = new TokenAccountant({ dataDir });
    expect(accountant.factorFor("bad")).toBe(1.0);
    expect(accountant.factorFor("good")).toBe(1.5);
  });

  it("tolerates a missing dataDir (first write creates it recursively)", () => {
    const dataDir = join(freshDir(), "nested", "deeper");
    const accountant = new TokenAccountant({ dataDir });
    accountant.observeUsage("m-nested", 100, 150);
    expect(existsSync(join(dataDir, "calibration.json"))).toBe(true);
  });

  it("defaults dataDir to .ctxh relative to the working directory", () => {
    const dataDir = freshDir();
    const previousCwd = process.cwd();
    process.chdir(dataDir);
    try {
      const accountant = new TokenAccountant(); // no dataDir -> ".ctxh"
      accountant.observeUsage("default-dir-model", 100, 150);
      expect(existsSync(join(dataDir, ".ctxh", "calibration.json"))).toBe(true);
      const reloaded = new TokenAccountant();
      expect(reloaded.factorFor("default-dir-model")).toBe(1.125);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
