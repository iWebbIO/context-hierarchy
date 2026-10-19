// HierarchyStrategy tests: a scripted FAKE adapter (records calls, returns
// canned digest text), the REAL TokenAccountant, and throwaway dataDirs under
// os.tmpdir(). No test here ever touches the network.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HierarchyStrategy,
  ProviderAdapter,
  SpillRestoreError,
  TokenAccountant,
} from "../src/index.js";
import type {
  ChatMessage,
  ChatParams,
  ChatResult,
  FitResult,
  StrategyCtx,
  StreamEvent,
} from "../src/index.js";

// The condense instruction, embedded verbatim in the condense prompt.
const CONDENSE_INSTRUCTION =
  "You compress a conversation history for a model with a very small context window. Preserve VERBATIM: all code blocks, quoted strings, file paths, identifiers, numbers, URLs, and every decision or commitment made. Output plain text only, no preamble, no meta-commentary. Be dense; omit nothing load-bearing.";

// Canned digest text the fake adapter returns for the one condense call.
const DIGEST =
  "DECISION: use sqlite for storage. PATH: src/db/schema.ts CODE: `SELECT 1 FROM t;` URL: https://example.com/spec.md COMMIT: ship by friday.";

/** Scripted fake adapter: records every chat() call, returns canned text. */
class ScriptedAdapter extends ProviderAdapter {
  readonly calls: ChatParams[] = [];
  private readonly respond: () => string;

  constructor(respond: () => string) {
    super({ baseUrl: "http://fake.invalid/v1", apiKey: "fake-key" });
    this.respond = respond;
  }

  chat(params: ChatParams): Promise<ChatResult> {
    this.calls.push(params);
    return Promise.resolve({ content: this.respond(), finishReason: "stop" });
  }

  async *stream(_params: ChatParams): AsyncGenerator<StreamEvent> {
    throw new Error("HierarchyStrategy must not call stream()");
  }

  async models(): Promise<unknown> {
    throw new Error("HierarchyStrategy must not call models()");
  }
}

/** Fails the test loudly if the strategy calls the model when it must not. */
function forbidden(): ScriptedAdapter {
  return new ScriptedAdapter(() => {
    throw new Error("adapter must not be called on this path");
  });
}

// Deterministic content builder (one word = one cl100k token for "lorem").
function text(words: number, word = "lorem"): string {
  return Array.from({ length: words }, () => word).join(" ");
}

const strategy = new HierarchyStrategy();

const dirs: string[] = [];

function makeCtx(adapter: ProviderAdapter): StrategyCtx {
  const dataDir = mkdtempSync(join(tmpdir(), "ctxh-hierarchy-test-"));
  dirs.push(dataDir);
  return {
    adapter,
    accountant: new TokenAccountant({ dataDir }),
    model: "hierarchy-test-model",
    dataDir,
  };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Spill completeness: every input message either appears verbatim
 * (identity) in the result or is spilled with a valid pointer whose
 * content-addressed file holds the FULL original and round-trips through
 * `restore`. Also cross-checks the two directions against each other.
 */
async function expectSpillComplete(
  messages: ChatMessage[],
  result: FitResult,
  ctx: StrategyCtx,
): Promise<void> {
  const spilledIdx = new Set(result.spill.map((s) => s.index));
  for (let i = 0; i < messages.length; i++) {
    const verbatim = result.messages.includes(messages[i]);
    expect(verbatim, `message ${i}: verbatim XOR spilled`).toBe(!spilledIdx.has(i));
    if (verbatim) continue;
    const entry = result.spill.find((s) => s.index === i);
    expect(entry, `message ${i}: removed but not spilled`).toBeDefined();
    expect(entry!.message, `message ${i}: spill must hold the full original`).toBe(
      messages[i],
    );
    expect(
      ["elided", "condensed", "dropped", "middle-cut"],
      `message ${i}: spill reason`,
    ).toContain(entry!.reason);
    expect(typeof entry!.pointer, `message ${i}: pointer is a string`).toBe("string");
    const file = join(ctx.dataDir, "hierarchy", "spills", entry!.pointer!);
    expect(existsSync(file), `message ${i}: spill file exists`).toBe(true);
    expect(
      JSON.parse(readFileSync(file, "utf8")),
      `message ${i}: spill file holds the full original`,
    ).toEqual(messages[i]);
    expect(await strategy.restore(entry!.pointer!, ctx), `message ${i}: restore round-trips`).toEqual(
      messages[i],
    );
  }
  for (const s of result.spill) {
    expect(s.index).toBeGreaterThanOrEqual(0);
    expect(s.index).toBeLessThan(messages.length);
    expect(s.message).toBe(messages[s.index]);
  }
}

describe("HierarchyStrategy — Stage 1 rules suffice: zero LLM", () => {
  it("passes under-budget input through untouched: same list, no spill, 0 adapter calls", async () => {
    const adapter = forbidden();
    const ctx = makeCtx(adapter);
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: text(12) },
      { role: "assistant", content: text(10) },
    ];
    const budget = ctx.accountant.estimate(messages, ctx.model) + 10;
    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);
    expect(result.messages).toBe(messages); // same list reference — untouched
    expect(result.spill).toEqual([]);
    expect(adapter.calls.length).toBe(0);
  });

  it("elides old tool results into one-line placeholders and fits: EXACTLY 0 adapter calls", async () => {
    const adapter = forbidden();
    const ctx = makeCtx(adapter);
    const sys: ChatMessage = { role: "system", content: "You are a terse assistant." };
    const toolA: ChatMessage = { role: "tool", tool_call_id: "call_a", content: text(400) };
    const toolB: ChatMessage = { role: "tool", tool_call_id: "call_b", content: text(400) };
    const u1: ChatMessage = { role: "user", content: "Summarize the current state." };
    const a1: ChatMessage = { role: "assistant", content: "State is nominal." };
    const toolC: ChatMessage = { role: "tool", tool_call_id: "call_c", content: text(400) }; // last 3 indices → survives
    const messages = [sys, toolA, toolB, u1, a1, toolC];

    // Over the original estimate, far above the post-elision one: each old
    // tool result (~465 est) becomes a ~25-token placeholder.
    const budget = ctx.accountant.estimate(messages, ctx.model) - 50;
    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);

    expect(adapter.calls.length).toBe(0); // EXACTLY zero adapter calls
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(budget);

    // Everything is still present; only the two OLD tool results were elided.
    expect(result.messages.length).toBe(6);
    expect(result.messages[0]).toBe(sys); // untouched, same reference
    expect(result.messages[3]).toBe(u1);
    expect(result.messages[4]).toBe(a1);
    expect(result.messages[5]).toBe(toolC); // recent tool result survives verbatim
    const elided = [
      [result.messages[1], toolA],
      [result.messages[2], toolB],
    ] as const;
    for (const [form, original] of elided) {
      expect(form.role).toBe("tool");
      expect(form.tool_call_id).toBe(original.tool_call_id); // other fields intact
      expect(form.content.startsWith("[elided tool result: ")).toBe(true);
      expect(form.content.endsWith("…]")).toBe(true);
      expect(form.content).toContain(
        original.content.slice(0, 60).replace(/[\r\n]+/g, " "),
      );
      expect(form.content.includes("\n")).toBe(false); // one line
    }

    // Spill: both old tool results, full originals, reason "elided".
    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([
      [1, "elided"],
      [2, "elided"],
    ]);
    expect(result.spill[0].message).toBe(toolA);
    expect(result.spill[1].message).toBe(toolB);
    await expectSpillComplete(messages, result, ctx);
  });
});

describe("HierarchyStrategy — Stage 2: exactly one capped condense call", () => {
  it("condenses the middle once; the call's prompt fits the cap; system/tail verbatim; digest markers", async () => {
    const adapter = new ScriptedAdapter(() => DIGEST);
    const ctx = makeCtx(adapter);
    const budget = 500;
    const sys: ChatMessage = { role: "system", content: "You are a terse assistant." };
    const m1: ChatMessage = { role: "user", content: text(300) };
    const m2: ChatMessage = { role: "assistant", content: text(280) };
    const m3: ChatMessage = { role: "user", content: text(320) };
    const m4: ChatMessage = { role: "assistant", content: text(260) };
    const t1: ChatMessage = { role: "user", content: "What did we decide?" };
    const t2: ChatMessage = { role: "assistant", content: "See the condensed history." };
    const t3: ChatMessage = { role: "user", content: "Summarize in one line." };
    const t4: ChatMessage = { role: "assistant", content: "Done." };
    const messages = [sys, m1, m2, m3, m4, t1, t2, t3, t4];

    // Live premises: the input is over budget, and the raw condense prompt
    // (instruction + elided middle) overflows the cap, forcing the internal fit.
    expect(ctx.accountant.estimate(messages, ctx.model)).toBeGreaterThan(budget);
    expect(
      ctx.accountant.estimate(
        [{ role: "system", content: CONDENSE_INSTRUCTION }, m1, m2, m3, m4],
        ctx.model,
      ),
    ).toBeGreaterThan(budget);

    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);

    // EXACTLY one adapter call, with the pinned params.
    expect(adapter.calls.length).toBe(1);
    const call = adapter.calls[0];
    expect(call.model).toBe(ctx.model);
    expect(call.max_tokens).toBe(800);
    expect(call.stream).toBeUndefined();

    // The instruction is embedded VERBATIM as the call's first message.
    expect(call.messages[0].content).toBe(CONDENSE_INSTRUCTION);
    // Everything after it is middle material (or a cut of one) — never the
    // system block, never the tail.
    const middles = [m1, m2, m3, m4];
    const MARKER = /\[\.\.\. context-hierarchy: elided ~\d+ tokens \.\.\.\]/;
    for (const m of call.messages.slice(1)) {
      expect(
        middles.includes(m) || MARKER.test(m.content),
        "condense call carries only middle material",
      ).toBe(true);
    }
    expect(call.messages).not.toContain(sys);
    for (const t of [t1, t2, t3, t4]) expect(call.messages).not.toContain(t);

    // The condense prompt fit the cap pre-dispatch.
    expect(ctx.accountant.estimate(call.messages, ctx.model)).toBeLessThanOrEqual(budget);

    // Stage 3 composition: system verbatim, digest wrapped in markers, tail verbatim.
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(budget);
    expect(result.messages[0]).toBe(sys);
    expect(result.messages[1].content).toBe(
      `[condensed history]\n${DIGEST}\n[/condensed history]`,
    );
    expect(result.messages.slice(-4)).toEqual([t1, t2, t3, t4]);

    // Spill: exactly the middle, "condensed", full originals.
    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([
      [1, "condensed"],
      [2, "condensed"],
      [3, "condensed"],
      [4, "condensed"],
    ]);
    result.spill.forEach((s, k) => expect(s.message).toBe(middles[k]));
    await expectSpillComplete(messages, result, ctx);
  });

  it("skips the internal fit when the condense prompt already fits the cap", async () => {
    const adapter = new ScriptedAdapter(() => DIGEST);
    const ctx = makeCtx(adapter);
    const budget = 500;
    const sysBig: ChatMessage = { role: "system", content: text(400) };
    const m1: ChatMessage = { role: "user", content: text(30) };
    const m2: ChatMessage = { role: "assistant", content: text(30) };
    const m3: ChatMessage = { role: "user", content: text(30) };
    const m4: ChatMessage = { role: "assistant", content: text(30) };
    const t1: ChatMessage = { role: "user", content: text(200) };
    const t2: ChatMessage = { role: "assistant", content: text(200) };
    const t3: ChatMessage = { role: "user", content: text(200) };
    const t4: ChatMessage = { role: "assistant", content: text(200) };
    const messages = [sysBig, m1, m2, m3, m4, t1, t2, t3, t4];

    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);

    expect(adapter.calls.length).toBe(1);
    // No internal fit: the call carries the instruction + middle EXACTLY.
    expect(adapter.calls[0].messages).toEqual([
      { role: "system", content: CONDENSE_INSTRUCTION },
      m1,
      m2,
      m3,
      m4,
    ]);
    expect(ctx.accountant.estimate(adapter.calls[0].messages, ctx.model)).toBeLessThanOrEqual(
      budget,
    );

    // Composition overflows (big system + big tail) → the hard-fit runs.
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(budget);
    expect(result.messages[0]).toBe(sysBig); // system never dropped
    // Spill: middle "condensed"; dropped tail "dropped"; the cut one "middle-cut".
    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([
      [1, "condensed"],
      [2, "condensed"],
      [3, "condensed"],
      [4, "condensed"],
      [5, "dropped"],
      [6, "dropped"],
      [7, "middle-cut"],
      [8, "dropped"],
    ]);
    await expectSpillComplete(messages, result, ctx);
  });

  it("builds the condense prompt from the ELIDED middle (placeholder, not the original)", async () => {
    const adapter = new ScriptedAdapter(() => DIGEST);
    const ctx = makeCtx(adapter);
    const budget = 500;
    const sysBig: ChatMessage = { role: "system", content: text(400) };
    const mTool: ChatMessage = { role: "tool", tool_call_id: "call_m", content: text(300) };
    const m2: ChatMessage = { role: "assistant", content: text(30) };
    const m3: ChatMessage = { role: "user", content: text(30) };
    const m4: ChatMessage = { role: "assistant", content: text(30) };
    const t1: ChatMessage = { role: "user", content: text(60) };
    const t2: ChatMessage = { role: "assistant", content: text(60) };
    const t3: ChatMessage = { role: "user", content: text(60) };
    const t4: ChatMessage = { role: "assistant", content: text(60) };
    const messages = [sysBig, mTool, m2, m3, m4, t1, t2, t3, t4];

    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);

    expect(adapter.calls.length).toBe(1);
    const call = adapter.calls[0];
    // mTool (index 1) is older than the last 3 indices → its PLACEHOLDER is sent.
    expect(call.messages.length).toBe(5); // no internal fit needed
    expect(call.messages[1].role).toBe("tool");
    expect(call.messages[1].tool_call_id).toBe("call_m");
    expect(call.messages[1].content.startsWith("[elided tool result: ")).toBe(true);
    expect(call.messages[1]).not.toBe(mTool); // not the original
    expect(call.messages.slice(2)).toEqual([m2, m3, m4]);

    // The ORIGINAL mTool is spilled in full under "condensed".
    expect(result.spill[0].index).toBe(1);
    expect(result.spill[0].reason).toBe("condensed");
    expect(result.spill[0].message).toBe(mTool);
    await expectSpillComplete(messages, result, ctx);
  });
});

describe("HierarchyStrategy — spill completeness, content addressing, restore", () => {
  it("spills an elided TAIL tool result (reason elided) whose file round-trips through restore", async () => {
    const adapter = forbidden(); // rules must suffice here
    const ctx = makeCtx(adapter);
    const sys: ChatMessage = { role: "system", content: "You are a terse assistant." };
    const toolOld: ChatMessage = { role: "tool", tool_call_id: "call_z", content: text(300) };
    const u1: ChatMessage = { role: "user", content: "Summarize the state." };
    const a1: ChatMessage = { role: "assistant", content: "State is nominal." };
    const u2: ChatMessage = { role: "user", content: "And now?" };
    const messages = [sys, toolOld, u1, a1, u2]; // N=5, tool cutoff 2 → toolOld(1) elided

    const budget = ctx.accountant.estimate(messages, ctx.model) - 50;
    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);

    expect(adapter.calls.length).toBe(0);
    // toolOld is tail material: its placeholder survives in the result, and the
    // original is spilled under "elided".
    expect(result.messages[1].content.startsWith("[elided tool result: ")).toBe(true);
    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([[1, "elided"]]);
    await expectSpillComplete(messages, result, ctx);
  });

  it("is deterministic and append-only: same input twice → same pointers, files intact", async () => {
    const adapter = new ScriptedAdapter(() => DIGEST);
    const ctx = makeCtx(adapter);
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: text(300) },
      { role: "assistant", content: text(280) },
      { role: "user", content: text(320) },
      { role: "assistant", content: text(260) },
      { role: "user", content: "What did we decide?" },
      { role: "assistant", content: "See above." },
      { role: "user", content: "Summarize." },
      { role: "assistant", content: "Done." },
    ];
    const budget = 500;
    const first = await strategy.fit({ messages, budgetTokens: budget }, ctx);
    const second = await strategy.fit({ messages, budgetTokens: budget }, ctx);

    // Content-addressed determinism: identical spill pointers both times.
    expect(second.spill.map((s) => s.pointer)).toEqual(first.spill.map((s) => s.pointer));
    // The files were never rewritten into garbage: they still hold the originals.
    for (const s of second.spill) {
      const file = join(ctx.dataDir, "hierarchy", "spills", s.pointer!);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(s.message);
      expect(await strategy.restore(s.pointer!, ctx)).toEqual(s.message);
    }
  });

  it("dedupes identical originals to ONE content-addressed file (two records, one file)", async () => {
    const adapter = forbidden(); // rules path
    const ctx = makeCtx(adapter);
    const sys: ChatMessage = { role: "system", content: "You are a terse assistant." };
    const dup: ChatMessage = { role: "tool", tool_call_id: "call_dup", content: text(300) };
    const u1: ChatMessage = { role: "user", content: "Summarize the state." };
    const a1: ChatMessage = { role: "assistant", content: "State is nominal." };
    const u2: ChatMessage = { role: "user", content: "And now?" };
    const u3: ChatMessage = { role: "user", content: "Really?" };
    // Two byte-identical tool messages (indices 1 and 2), both old enough to elide.
    const messages = [sys, dup, { ...dup }, u1, a1, u2, u3];

    const budget = ctx.accountant.estimate(messages, ctx.model) - 50;
    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);

    expect(adapter.calls.length).toBe(0);
    expect(result.spill.length).toBe(2); // one record per input index…
    expect(result.spill[0].pointer).toBe(result.spill[1].pointer); // …sharing one file
    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([
      [1, "elided"],
      [2, "elided"],
    ]);
    const files = readdirSync(join(ctx.dataDir, "hierarchy", "spills"));
    expect(files).toEqual([result.spill[0].pointer]);
    expect(await strategy.restore(result.spill[0].pointer!, ctx)).toEqual(dup);
  });
});

describe("HierarchyStrategy — restore on a bad pointer throws (never garbage)", () => {
  it("throws SpillRestoreError on malformed or never-written pointers", async () => {
    const ctx = makeCtx(new ScriptedAdapter(() => "x"));
    await expect(strategy.restore("deadbeef.json", ctx)).rejects.toThrow(SpillRestoreError);
    await expect(strategy.restore("", ctx)).rejects.toThrow(SpillRestoreError);
    await expect(strategy.restore(`..\\..\\secrets.json`, ctx)).rejects.toThrow(SpillRestoreError);
    // Well-formed name that was never written.
    await expect(strategy.restore(`${"0".repeat(64)}.json`, ctx)).rejects.toThrow(
      SpillRestoreError,
    );
  });

  it("throws SpillRestoreError on corrupt files: invalid JSON, wrong shape, hash mismatch", async () => {
    const ctx = makeCtx(new ScriptedAdapter(() => "x"));
    const dir = join(ctx.dataDir, "hierarchy", "spills");
    mkdirSync(dir, { recursive: true });
    const put = (seed: string, content: string): string => {
      const name = `${sha256Hex(seed)}.json`; // valid pointer shape, arbitrary seed
      writeFileSync(join(dir, name), content, "utf8");
      return name;
    };

    const badJson = put("bad-json", "not json {{{");
    await expect(strategy.restore(badJson, ctx)).rejects.toThrow(SpillRestoreError);
    const wrongShape = put("wrong-shape", JSON.stringify({ role: "wizard", content: 1 }));
    await expect(strategy.restore(wrongShape, ctx)).rejects.toThrow(SpillRestoreError);
    const badToolCalls = put(
      "bad-tool-calls",
      JSON.stringify({ role: "tool", content: "x", tool_calls: "nope" }),
    );
    await expect(strategy.restore(badToolCalls, ctx)).rejects.toThrow(SpillRestoreError);
    const tampered = put("tampered", JSON.stringify({ role: "user", content: "tampered" }));
    await expect(strategy.restore(tampered, ctx)).rejects.toThrow(SpillRestoreError);
  });
});

describe("HierarchyStrategy — blank-line collapse", () => {
  it("collapses runs of 3+ blank lines to a single blank line; 1–2 blank lines untouched", async () => {
    const adapter = forbidden(); // rules must suffice
    const ctx = makeCtx(adapter);
    const five = `header${"\n".repeat(6)}tail`; // 5 blank lines → collapse
    const two = `head${"\n".repeat(3)}tail`; // 2 blank lines → untouched
    const one = "a\n\nb"; // 1 blank line → untouched
    const sys: ChatMessage = { role: "system", content: "You are a terse assistant." };
    const toolHuge: ChatMessage = { role: "tool", tool_call_id: "call_h", content: text(300) };
    const uFive: ChatMessage = { role: "user", content: five };
    const aTwo: ChatMessage = { role: "assistant", content: two };
    const uOne: ChatMessage = { role: "user", content: one };
    const uLast: ChatMessage = { role: "user", content: "Final question?" };
    const messages = [sys, toolHuge, uFive, aTwo, uOne, uLast]; // tool cutoff 3 → toolHuge(1) elided

    const budget = ctx.accountant.estimate(messages, ctx.model) - 50;
    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);

    expect(adapter.calls.length).toBe(0);
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(budget);

    // The 5-blank-line message collapsed to a single blank line; 2 and 1 did not.
    expect(result.messages[2].content).toBe("header\n\ntail");
    expect(result.messages[3].content).toBe(two);
    expect(result.messages[4].content).toBe(one);

    // Spill: the elided tool result AND the collapsed message (its original is
    // no longer verbatim in the result); the untouched ones are not spilled.
    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([
      [1, "elided"],
      [2, "elided"],
    ]);
    await expectSpillComplete(messages, result, ctx);
  });
});

describe("HierarchyStrategy — system-only overflow resolves (digest of nothing)", () => {
  it("all-system input: no condense call, systems middle-cut by the hard-fit, cap intact", async () => {
    const adapter = forbidden(); // empty middle → nothing to condense
    const ctx = makeCtx(adapter);
    const s1: ChatMessage = { role: "system", content: text(300) };
    const s2: ChatMessage = { role: "system", content: text(250) };
    const messages = [s1, s2];
    const budget = 300;
    expect(ctx.accountant.estimate(messages, ctx.model)).toBeGreaterThan(budget);

    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);

    expect(adapter.calls.length).toBe(0);
    expect(result.messages.length).toBe(2); // systems are never dropped
    expect(result.messages.every((m) => m.role === "system")).toBe(true);
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(budget);
    // No middle → no digest message at all.
    expect(result.messages.some((m) => m.content.includes("[condensed history]"))).toBe(false);
    // Both originals spilled in full as middle-cuts, restorable.
    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([
      [0, "middle-cut"],
      [1, "middle-cut"],
    ]);
    await expectSpillComplete(messages, result, ctx);
  });

  it("systems + short tail (no middle): zero calls, last user survives, spill covers the rest", async () => {
    const adapter = forbidden(); // non-system count 2 ≤ 4 → no middle
    const ctx = makeCtx(adapter);
    const s1: ChatMessage = { role: "system", content: text(300) };
    const s2: ChatMessage = { role: "system", content: text(250) };
    const u1: ChatMessage = { role: "user", content: "Hi there." };
    const a1: ChatMessage = { role: "assistant", content: "Hello." };
    const messages = [s1, s2, u1, a1];
    const budget = 300;

    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);

    expect(adapter.calls.length).toBe(0); // nothing to condense
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(budget);
    expect(result.messages.some((m) => m.content.includes("[condensed history]"))).toBe(false);
    // The hard-fit resolved it: systems cut (never dropped), last user kept
    // verbatim, the older assistant message dropped.
    expect(result.messages.filter((m) => m.role === "system").length).toBe(2);
    expect(result.messages).toContain(u1);
    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([
      [0, "middle-cut"],
      [1, "middle-cut"],
      [3, "dropped"],
    ]);
    await expectSpillComplete(messages, result, ctx);
  });
});
