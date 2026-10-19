import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TokenAccountant, TruncationStrategy } from "../src/index.js";
import type { ChatMessage, ProviderAdapter, StrategyCtx } from "../src/index.js";

// Deterministic content builder: repeated single words, so tests can compute
// every budget from live accountant estimates instead of hand-counted tokens.
function text(words: number, word = "lorem"): string {
  return Array.from({ length: words }, () => word).join(" ");
}

// Any property access on the adapter throws: TruncationStrategy must never
// touch it (no adapter calls, no network). Every test in this file uses one.
function forbiddenAdapter(): ProviderAdapter {
  return new Proxy({} as ProviderAdapter, {
    get(_target, prop) {
      throw new Error(`TruncationStrategy must not touch the adapter (accessed: ${String(prop)})`);
    },
  });
}

// All tests run against throwaway dataDirs under os.tmpdir() — never the
// repo's .ctxh — and an unobserved model, so every estimate below is the pure
// margin-1.15 count (deterministic).
const dirs: string[] = [];

function makeCtx(): StrategyCtx {
  const dataDir = mkdtempSync(join(tmpdir(), "ctxh-trunc-test-"));
  dirs.push(dataDir);
  return {
    adapter: forbiddenAdapter(),
    accountant: new TokenAccountant({ dataDir }),
    model: "trunc-test-model",
    dataDir,
  };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const strategy = new TruncationStrategy();

// Marker contract: one line, bracketed, with the elided token count.
const MARKER_RE = /\[\.\.\. context-hierarchy: elided ~(\d+) tokens \.\.\.\]/g;

describe("TruncationStrategy.fit — pass-through", () => {
  it("returns a Promise (async seam) even though the work is synchronous", async () => {
    const ctx = makeCtx();
    const pending = strategy.fit({ messages: [], budgetTokens: 64 }, ctx);
    expect(pending).toBeInstanceOf(Promise);
    const result = await pending;
    expect(result.messages).toEqual([]);
    expect(result.spill).toEqual([]);
  });

  it("under-budget input passes through unchanged: same messages, empty spill", async () => {
    const ctx = makeCtx();
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: text(12) },
      { role: "assistant", content: text(10) },
      { role: "user", content: text(8) },
    ];
    const budget = ctx.accountant.estimate(messages, ctx.model) + 10;
    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);
    expect(result.messages).toBe(messages); // same list reference — untouched
    expect(result.spill).toEqual([]);
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(budget);
  });

  it("empty messages and only-system inputs fit at the floor budget", async () => {
    const ctx = makeCtx();
    const empty = await strategy.fit({ messages: [], budgetTokens: 64 }, ctx);
    expect(empty.messages).toEqual([]);
    expect(empty.spill).toEqual([]);

    const onlySystem: ChatMessage[] = [{ role: "system", content: "Be brief." }];
    const fitted = await strategy.fit({ messages: onlySystem, budgetTokens: 64 }, ctx);
    expect(fitted.messages).toBe(onlySystem); // under budget → verbatim
    expect(fitted.spill).toEqual([]);
  });
});

describe("TruncationStrategy.fit — drop-oldest fitting", () => {
  it("drops oldest first; keeps system, last user, newest tail; spills the rest in full", async () => {
    const ctx = makeCtx();
    const sys: ChatMessage = { role: "system", content: "You are a terse assistant." };
    const u1: ChatMessage = { role: "user", content: text(40) };
    const a1: ChatMessage = { role: "assistant", content: text(30) };
    const u2: ChatMessage = { role: "user", content: text(25) };
    const a2: ChatMessage = { role: "assistant", content: text(20) };
    const u3: ChatMessage = { role: "user", content: text(35) }; // LAST user
    const messages = [sys, u1, a1, u2, a2, u3];

    const estOf = (m: ChatMessage) => ctx.accountant.estimate([m], ctx.model);
    // Room for system + last user + the newest droppable (a2) plus 2 tokens of
    // slack — not enough for the next-newest droppable (u2, which costs at
    // least 6): the fill must stop after a2.
    const budget = estOf(sys) + estOf(u3) + estOf(a2) + 2;

    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);

    // Shape: system at head, kept tail in order, last user placed last.
    expect(result.messages.map((m) => m.role)).toEqual(["system", "assistant", "user"]);
    expect(result.messages[0]).toBe(sys); // verbatim, same reference
    expect(result.messages[1]).toBe(a2);
    expect(result.messages[2]).toBe(u3); // never dropped, placed last, intact

    // Spill: the three OLDEST droppables, original indices, full originals.
    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([
      [1, "dropped-oldest"],
      [2, "dropped-oldest"],
      [3, "dropped-oldest"],
    ]);
    expect(result.spill[0].message).toBe(u1);
    expect(result.spill[1].message).toBe(a1);
    expect(result.spill[2].message).toBe(u2);

    // The cap invariant, checked with the accountant itself.
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(budget);
  });

  it("interleaved system messages all survive, keeping head-position order", async () => {
    const ctx = makeCtx();
    const u0: ChatMessage = { role: "user", content: text(50) };
    const s1: ChatMessage = { role: "system", content: "First rule." };
    const s2: ChatMessage = { role: "system", content: "Second rule." };
    const a3: ChatMessage = { role: "assistant", content: text(12) };
    const u4: ChatMessage = { role: "user", content: text(10) }; // LAST user
    const messages = [u0, s1, s2, a3, u4];

    const estOf = (m: ChatMessage) => ctx.accountant.estimate([m], ctx.model);
    // Only u0 must be dropped: budget covers everything else plus 1 token of
    // slack (u0 costs far more than 1).
    const budget = estOf(s1) + estOf(s2) + estOf(a3) + estOf(u4) + 1;

    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);
    expect(result.messages).toEqual([s1, s2, a3, u4]); // systems at head, in order
    expect(result.messages[0]).toBe(s1);
    expect(result.messages[1]).toBe(s2);
    expect(result.messages[3]).toBe(u4); // last user placed last
    expect(result.spill).toEqual([{ index: 0, message: u0, reason: "dropped-oldest" }]);
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(budget);
  });

  it("kept + spilled covers every original index (restoration data is complete)", async () => {
    const ctx = makeCtx();
    const sys: ChatMessage = { role: "system", content: "You are a terse assistant." };
    const u1: ChatMessage = { role: "user", content: text(40) };
    const a1: ChatMessage = { role: "assistant", content: text(30) };
    const u2: ChatMessage = { role: "user", content: text(25) };
    const a2: ChatMessage = { role: "assistant", content: text(20) };
    const u3: ChatMessage = { role: "user", content: text(35) };
    const messages = [sys, u1, a1, u2, a2, u3];

    const estOf = (m: ChatMessage) => ctx.accountant.estimate([m], ctx.model);
    const budget = estOf(sys) + estOf(u3) + estOf(a2) + 2;
    const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);

    const covered = new Set<number>(result.spill.map((s) => s.index));
    for (const kept of result.messages) {
      const idx = messages.indexOf(kept); // identity lookup
      expect(idx).toBeGreaterThanOrEqual(0);
      covered.add(idx);
    }
    expect([...covered].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("is deterministic: fitting the same input twice yields identical results", async () => {
    const ctx = makeCtx();
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: text(60) },
      { role: "assistant", content: text(40) },
      { role: "user", content: text(30) },
    ];
    const budget = 100;
    const first = await strategy.fit({ messages, budgetTokens: budget }, ctx);
    const second = await strategy.fit({ messages, budgetTokens: budget }, ctx);
    expect(second).toEqual(first);
    expect(ctx.accountant.estimate(first.messages, ctx.model)).toBeLessThanOrEqual(budget);
  });
});

describe("TruncationStrategy.fit — middle-cut", () => {
  function parseCut(content: string): { head: string; tail: string; marker: string; n: number } {
    const matches = [...content.matchAll(MARKER_RE)];
    expect(matches.length, "exactly one marker line present").toBe(1);
    const marker = matches[0][0];
    const at = content.indexOf(marker);
    expect(content.slice(at - 1, at)).toBe("\n");
    expect(content.slice(at + marker.length, at + marker.length + 1)).toBe("\n");
    return {
      head: content.slice(0, at - 1),
      tail: content.slice(at + marker.length + 1),
      marker,
      n: Number.parseInt(matches[0][1], 10),
    };
  }

  it("middle-cuts a single giant user message at the floor budget (64)", async () => {
    const ctx = makeCtx();
    const giant: ChatMessage = { role: "user", content: text(3000) };
    const result = await strategy.fit({ messages: [giant], budgetTokens: 64 }, ctx);

    expect(result.messages.length).toBe(1);
    const cut = result.messages[0];
    expect(cut.role).toBe("user");
    const { head, tail, n } = parseCut(cut.content);

    // Head + tail are verbatim prefix/suffix slices of the original.
    expect(giant.content.slice(0, head.length)).toBe(head);
    expect(giant.content.slice(giant.content.length - tail.length)).toBe(tail);
    expect(head.length).toBeGreaterThan(0);
    expect(tail.length).toBeGreaterThan(0);
    // The middle really was removed, and the elided count is real.
    expect(cut.content.length).toBeLessThan(giant.content.length);
    expect(n).toBeGreaterThan(0);

    // The spill carries the FULL original message under "middle-cut".
    expect(result.spill).toHaveLength(1);
    expect(result.spill[0].index).toBe(0);
    expect(result.spill[0].reason).toBe("middle-cut");
    expect(result.spill[0].message).toBe(giant);

    // Cap invariant at the floor budget.
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(64);
  });

  it("middle-cuts the last user message after system messages are subtracted", async () => {
    const ctx = makeCtx();
    const sys: ChatMessage = { role: "system", content: "You are a terse assistant." };
    const u1: ChatMessage = { role: "user", content: text(50) }; // droppable
    const giant: ChatMessage = { role: "user", content: text(3000) }; // LAST user
    const messages = [sys, u1, giant];
    const result = await strategy.fit({ messages, budgetTokens: 64 }, ctx);

    expect(result.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(result.messages[0]).toBe(sys); // system verbatim
    const { head, tail } = parseCut(result.messages[1].content);
    expect(giant.content.slice(0, head.length)).toBe(head);
    expect(giant.content.slice(giant.content.length - tail.length)).toBe(tail);

    // Spill in index order: the dropped-oldest user plus the middle-cut full original.
    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([
      [1, "dropped-oldest"],
      [2, "middle-cut"],
    ]);
    expect(result.spill[0].message).toBe(u1);
    expect(result.spill[1].message).toBe(giant);
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(64);
  });

  it("keeps other message fields intact when middle-cutting", async () => {
    const ctx = makeCtx();
    const giant: ChatMessage = {
      role: "user",
      content: text(3000),
      name: "caller",
      tool_call_id: "call_9",
    };
    const result = await strategy.fit({ messages: [giant], budgetTokens: 64 }, ctx);
    const cut = result.messages[0];
    expect(cut.name).toBe("caller");
    expect(cut.tool_call_id).toBe("call_9");
    expect(result.spill[0].message).toBe(giant); // original untouched in spill
  });
});

describe("TruncationStrategy.fit — unsatisfiable inputs", () => {
  it("trips the invariant when verbatim system messages alone exceed the budget", async () => {
    const ctx = makeCtx();
    const bigSystem: ChatMessage = { role: "system", content: text(3000) };
    // No user message: everything droppable is dropped and the system block
    // still cannot fit — "keep all system verbatim" and "<= budget" cannot
    // both hold, which the strategy surfaces instead of silently breaking one.
    await expect(
      strategy.fit({ messages: [bigSystem], budgetTokens: 64 }, ctx),
    ).rejects.toThrow(/truncation invariant violated/);

    // Same conflict one step deeper: a system block so big that after it is
    // subtracted there is no room for the last user message's shell + marker.
    const withUser: ChatMessage[] = [
      { role: "system", content: text(3000) },
      { role: "user", content: "hi" },
    ];
    await expect(
      strategy.fit({ messages: withUser, budgetTokens: 64 }, ctx),
    ).rejects.toThrow(/truncation invariant violated/);
  });
});

describe("TruncationStrategy.fit — property test (seeded LCG, no Math.random)", () => {
  // Tiny deterministic LCG (Numerical Recipes constants), seeded with a constant.
  function makeLcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  // Vocabulary for generated content. System messages draw from the short,
  // single-token list and stay small: a verbatim system block larger than the
  // floor budget is the one input no strategy can fit (tested above as the
  // invariant case), so the generator keeps it inside the satisfiable domain.
  const SYSTEM_WORDS = ["be", "brief", "answer", "code", "test", "help", "the", "a", "of", "is"];
  const WORDS = [
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota",
    "kappa", "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "phi", "chi",
    "psi", "omega", "lorem", "ipsum", "dolor", "sit", "amet", "fn()", "`tick`",
    "{code}", "x=1;", "return",
  ];

  function genContent(rand: () => number, words: number, vocab: string[]): string {
    const parts: string[] = [];
    for (let i = 0; i < words; i++) parts.push(vocab[Math.floor(rand() * vocab.length)]);
    return parts.join(" ");
  }

  function genMessages(rand: () => number): ChatMessage[] {
    const count = Math.floor(rand() * 13);
    const messages: ChatMessage[] = [];
    for (let i = 0; i < count; i++) {
      const roll = rand();
      let role: ChatMessage["role"];
      let content: string;
      if (i === 0 && roll < 0.3) {
        role = "system";
        content = genContent(rand, 1 + Math.floor(rand() * 8), SYSTEM_WORDS);
      } else if (roll < 0.55) {
        role = "user";
        const words = rand() < 0.25 ? 100 + Math.floor(rand() * 400) : 1 + Math.floor(rand() * 12);
        content = genContent(rand, words, WORDS);
      } else if (roll < 0.85) {
        role = "assistant";
        content = genContent(rand, 1 + Math.floor(rand() * 12), WORDS);
      } else {
        role = "tool";
        content = genContent(rand, 1 + Math.floor(rand() * 12), WORDS);
      }
      messages.push({ role, content });
    }
    return messages;
  }

  it("for seeded random inputs × random budgets ≥ 64: fits the budget and spills every drop", async () => {
    const rand = makeLcg(20261019);
    const ctx = makeCtx(); // one accountant, one throwing adapter for all cases
    const CASES = 250;

    for (let c = 0; c < CASES; c++) {
      const messages = genMessages(rand);
      const budget = 64 + Math.floor(rand() * 2000);
      const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);

      const fitted = result.messages;
      const where = `case ${c}: ${messages.length} messages, budget ${budget}`;

      // Invariant: the result always fits the budget.
      expect(
        ctx.accountant.estimate(fitted, ctx.model),
        `${where} — fitted result exceeded budget`,
      ).toBeLessThanOrEqual(budget);

      // Every system message survived verbatim (identity), in relative order.
      const keptSystems = fitted.filter((m) => m.role === "system");
      const originalSystems = messages.filter((m) => m.role === "system");
      expect(keptSystems.length, where).toBe(originalSystems.length);
      originalSystems.forEach((s, i) => expect(keptSystems[i], where).toBe(s));

      // Every message absent from the result (identity) is spilled, with its
      // original index and the full original message.
      const keptIdx = new Set<number>();
      for (const kept of fitted) {
        const idx = messages.indexOf(kept);
        if (idx >= 0) keptIdx.add(idx);
      }
      for (let i = 0; i < messages.length; i++) {
        if (keptIdx.has(i)) continue;
        const entry = result.spill.find((s) => s.index === i);
        expect(entry, `${where} — dropped message ${i} missing from spill`).toBeDefined();
        expect(entry!.message, `${where} — spill entry ${i} is not the full original`).toBe(
          messages[i],
        );
      }
      // Spill entries all point at real original indices.
      for (const s of result.spill) {
        expect(s.index, where).toBeGreaterThanOrEqual(0);
        expect(s.index, where).toBeLessThan(messages.length);
        expect(s.message, where).toBe(messages[s.index]);
      }

      // When fitting actually removed something and a user message existed,
      // the last result message is the (possibly middle-cut) last user message.
      const hasUser = messages.some((m) => m.role === "user");
      if (result.spill.length > 0 && hasUser) {
        expect(fitted[fitted.length - 1].role, where).toBe("user");
      }

      // Droppables (non-system, non-last-user) that survive form a contiguous
      // suffix in original order: what is dropped is exactly the oldest.
      let lastUserIdx = -1;
      messages.forEach((m, i) => {
        if (m.role === "user") lastUserIdx = i;
      });
      const droppableOrder = messages
        .map((_, i) => i)
        .filter((i) => i !== lastUserIdx && messages[i].role !== "system");
      const keptDroppables = droppableOrder.filter((i) => keptIdx.has(i));
      if (keptDroppables.length > 0) {
        const firstKept = droppableOrder.indexOf(keptDroppables[0]);
        expect(keptDroppables, where).toEqual(droppableOrder.slice(firstKept));
        // No middle-cut in this case: the kept suffix must be identity-kept.
        if (result.spill.every((s) => s.reason === "dropped-oldest")) {
          for (const i of keptDroppables) expect(fitted.includes(messages[i]), where).toBe(true);
        }
      }
    }
  });
});
