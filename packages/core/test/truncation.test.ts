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

// Parse a middle-cut: exactly one marker line, newline-delimited when head
// and/or tail slices exist (a floor allocation may be marker-only).
function parseCut(content: string, where = "middle-cut"): { head: string; tail: string; n: number } {
  const matches = [...content.matchAll(MARKER_RE)];
  expect(matches.length, `${where}: exactly one marker line present`).toBe(1);
  const marker = matches[0][0];
  const at = content.indexOf(marker);
  const before = content.slice(0, at);
  const after = content.slice(at + marker.length);
  if (before.length > 0 || after.length > 0) {
    expect(before.endsWith("\n"), `${where}: head not newline-delimited`).toBe(true);
    expect(after.startsWith("\n"), `${where}: tail not newline-delimited`).toBe(true);
  }
  return {
    head: before.endsWith("\n") ? before.slice(0, -1) : before,
    tail: after.startsWith("\n") ? after.slice(1) : after,
    n: Number.parseInt(matches[0][1], 10),
  };
}

// Assert a result message is a proper cut of `original`: verbatim head/tail
// slices, one marker, non-negative elided count.
function expectProperCut(form: ChatMessage, original: ChatMessage, where: string): void {
  const { head, tail, n } = parseCut(form.content, where);
  expect(original.content.slice(0, head.length), where).toBe(head);
  expect(original.content.slice(original.content.length - tail.length), where).toBe(tail);
  expect(n, where).toBeGreaterThan(0);
}

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

describe("TruncationStrategy.fit — system overflow (final resort)", () => {
  it("middle-cuts a single giant system message at the floor budget (64)", async () => {
    // One 3000-word system at budget 64 — the fit MUST succeed; this path
    // exists so it never throws.
    const ctx = makeCtx();
    const giantSystem: ChatMessage = { role: "system", content: text(3000) };
    const result = await strategy.fit({ messages: [giantSystem], budgetTokens: 64 }, ctx);

    expect(result.messages.length).toBe(1); // never dropped
    expect(result.messages[0].role).toBe("system");
    expectProperCut(result.messages[0], giantSystem, "cut system");

    // Full original spilled under "middle-cut".
    expect(result.spill).toEqual([
      { index: 0, message: giantSystem, reason: "middle-cut" },
    ]);
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(64);
  });

  it("reserves the last-user floor when cutting the system block", async () => {
    const ctx = makeCtx();
    const giantSystem: ChatMessage = { role: "system", content: text(3000) };
    const giantUser: ChatMessage = { role: "user", content: text(2000) };
    const result = await strategy.fit(
      { messages: [giantSystem, giantUser], budgetTokens: 64 },
      ctx,
    );

    // System cut at the head, last user placed last at its marker floor
    // (the floor allocation is marker-only: no room for head/tail slices).
    expect(result.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expectProperCut(result.messages[0], giantSystem, "cut system");
    const userCut = parseCut(result.messages[1].content, "floor-cut user");
    expect(userCut.head).toBe("");
    expect(userCut.tail).toBe("");

    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([
      [0, "middle-cut"],
      [1, "middle-cut"],
    ]);
    expect(result.spill[0].message).toBe(giantSystem);
    expect(result.spill[1].message).toBe(giantUser);
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(64);
  });

  it("cuts the LARGEST system first; a smaller system stays verbatim when room remains", async () => {
    const ctx = makeCtx();
    const giant: ChatMessage = { role: "system", content: text(3000) };
    const small: ChatMessage = { role: "system", content: "Be terse." };
    const result = await strategy.fit({ messages: [giant, small], budgetTokens: 64 }, ctx);

    // The smaller system keeps its verbatim slot; the giant absorbs the cut.
    expect(result.messages[0].role).toBe("system");
    expectProperCut(result.messages[0], giant, "largest system cut");
    expect(result.messages[1]).toBe(small); // verbatim, same reference
    expect(result.spill).toEqual([{ index: 0, message: giant, reason: "middle-cut" }]);
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(64);
  });

  it("middle-cuts multiple oversized systems, in head order, both spilled in full", async () => {
    const ctx = makeCtx();
    const a: ChatMessage = { role: "system", content: text(3000) };
    const b: ChatMessage = { role: "system", content: text(2500) };
    const result = await strategy.fit({ messages: [a, b], budgetTokens: 64 }, ctx);

    expect(result.messages.map((m) => m.role)).toEqual(["system", "system"]);
    expectProperCut(result.messages[0], a, "system a cut");
    expectProperCut(result.messages[1], b, "system b cut");
    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([
      [0, "middle-cut"],
      [1, "middle-cut"],
    ]);
    expect(result.spill[0].message).toBe(a);
    expect(result.spill[1].message).toBe(b);
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(64);
  });

  it("cuts systems when verbatim systems leave less than the last-user floor", async () => {
    // Systems fit verbatim on their own, but 64 - estSystem < the user's
    // marker floor: the fit invariant wins, so systems are cut — not thrown.
    const ctx = makeCtx();
    const sys: ChatMessage = { role: "system", content: text(46) };
    const giant: ChatMessage = { role: "user", content: text(2000) };
    const estSys = ctx.accountant.estimate([sys], ctx.model);
    const estGiant = ctx.accountant.estimate([giant], ctx.model);
    const userCutFloor = ctx.accountant.estimate(
      [{ ...giant, content: `[... context-hierarchy: elided ~${estGiant} tokens ...]` }],
      ctx.model,
    );
    // Live-verify the premise of this path.
    expect(estSys).toBeLessThanOrEqual(64); // system block fits verbatim alone
    expect(estSys + userCutFloor).toBeGreaterThan(64); // ...but starves the user floor

    const result = await strategy.fit({ messages: [sys, giant], budgetTokens: 64 }, ctx);
    expect(result.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expectProperCut(result.messages[0], sys, "system cut");
    parseCut(result.messages[1].content, "floor-cut user");
    expect(result.spill.map((s) => [s.index, s.reason])).toEqual([
      [0, "middle-cut"],
      [1, "middle-cut"],
    ]);
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(64);
  });

  it("degenerates to empty shells when marker floors cannot fit, never dropping systems", async () => {
    // Four ~28-estimate systems at budget 64: the four marker floors
    // (~20 each) exceed the budget, so allocations degenerate — one system
    // verbatim, one middle-cut, two empty shells — all four present, every
    // non-verbatim one spilled with its full original.
    const ctx = makeCtx();
    const systems = Array.from(
      { length: 4 },
      (): ChatMessage => ({ role: "system", content: text(20) }),
    );
    const result = await strategy.fit({ messages: systems, budgetTokens: 64 }, ctx);

    expect(result.messages.length).toBe(4); // never dropped
    expect(result.messages.every((m) => m.role === "system")).toBe(true);
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(64);

    for (let i = 0; i < 4; i++) {
      if (result.messages[i] === systems[i]) continue; // kept verbatim
      const entry = result.spill.find((s) => s.index === i);
      expect(entry, `system ${i} not spilled`).toBeDefined();
      expect(entry!.reason).toBe("middle-cut");
      expect(entry!.message).toBe(systems[i]);
      if (result.messages[i].content !== "") {
        expectProperCut(result.messages[i], systems[i], `system ${i} cut`);
      }
    }
    expect(result.spill.length).toBeGreaterThan(0); // the case is degenerate by construction
  });

  it("fits when per-message shell sums exceed the budget but their joint estimate does not", async () => {
    // 13 systems of ~3 tokens each: verbatim joint = 105 > 64, the sum of
    // per-message shell estimates = 13 × 5 = 65 > 64, yet the JOINT estimate
    // of the shells = ceil(13 × 4 × 1.15) = 60 <= 64. The fit must succeed
    // by degenerating every system to an empty shell — allocation math may
    // over-reserve against per-message sums, but only the joint estimate
    // decides the cap.
    const ctx = makeCtx();
    const systems = Array.from(
      { length: 13 },
      (): ChatMessage => ({ role: "system", content: "alpha beta gamma" }),
    );
    const result = await strategy.fit({ messages: systems, budgetTokens: 64 }, ctx);

    expect(result.messages.length).toBe(13); // never dropped
    expect(result.messages.every((m) => m.role === "system")).toBe(true);
    expect(result.messages.every((m) => m.content === "")).toBe(true); // all shells
    expect(result.spill.map((s) => s.reason)).toEqual(
      Array.from({ length: 13 }, () => "middle-cut"),
    );
    result.spill.forEach((s, i) => expect(s.message).toBe(systems[i]));
    expect(ctx.accountant.estimate(result.messages, ctx.model)).toBeLessThanOrEqual(64);
  });

  it("still trips the bug detector only when even empty shells cannot fit (mathematical corner)", async () => {
    // 14 never-droppable messages at budget 64: each empty shell has a raw
    // cost of 4 tokens, and the joint estimate ceil(14 × 4 × 1.15) = 65 > 64
    // — no strategy can satisfy the cap. (13 shells cost 60 and fit.) This
    // is the only input class left that throws; every other input class fits.
    const ctx = makeCtx();
    const fourteenSystems = Array.from(
      { length: 14 },
      (): ChatMessage => ({ role: "system", content: "x" }),
    );
    await expect(
      strategy.fit({ messages: fourteenSystems, budgetTokens: 64 }, ctx),
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

  // Vocabulary for generated content. System messages are usually small but
  // may be giant (the system-overflow path); they are capped at 4 per case so
  // the never-droppable set stays far from the empty-shell mathematical
  // corner (5 kept messages x 5 shell tokens = 25 <= 64).
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
    const count = Math.floor(rand() * 13); // 0..12 messages
    const messages: ChatMessage[] = [];
    let systems = 0;
    for (let i = 0; i < count; i++) {
      const roll = rand();
      let role: ChatMessage["role"];
      let content: string;
      if (roll < 0.15 && systems < 4) {
        role = "system";
        systems++;
        content =
          rand() < 0.25
            ? genContent(rand, 100 + Math.floor(rand() * 400), WORDS)
            : genContent(rand, 1 + Math.floor(rand() * 8), SYSTEM_WORDS);
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
    let sawSystemCut = 0; // sanity: the generator reaches the final resort

    for (let c = 0; c < CASES; c++) {
      const messages = genMessages(rand);
      const budget = 64 + Math.floor(rand() * 2000);
      const result = await strategy.fit({ messages, budgetTokens: budget }, ctx);
      const fitted = result.messages;
      const where = `case ${c}: ${messages.length} messages, budget ${budget}`;

      // Invariant: the result always fits the budget — no input class excepted.
      expect(
        ctx.accountant.estimate(fitted, ctx.model),
        `${where} — fitted result exceeded budget`,
      ).toBeLessThanOrEqual(budget);

      // System messages are never dropped; roles survive cuts.
      const inputSystems = messages.filter((m) => m.role === "system");
      const resultSystems = fitted.filter((m) => m.role === "system");
      expect(resultSystems.length, `${where} — system dropped`).toBe(inputSystems.length);

      // k-th result system ↔ k-th input system (head order preserved): kept
      // verbatim, degenerated to a shell, or properly middle-cut with the
      // full original spilled.
      for (let k = 0; k < inputSystems.length; k++) {
        const original = inputSystems[k];
        const form = resultSystems[k];
        const w = `${where} — system ${k}`;
        if (form === original) continue; // verbatim, same reference
        const entry = result.spill.find((s) => s.message === original);
        expect(entry, `${w} not spilled`).toBeDefined();
        expect(entry!.reason, w).toBe("middle-cut");
        if (form.content === "") continue; // empty-shell degeneration
        expectProperCut(form, original, w);
        sawSystemCut++;
      }

      // The last user is never dropped and, once anything was removed, is the
      // (possibly middle-cut) last message of the result.
      let lastUserIdx = -1;
      messages.forEach((m, i) => {
        if (m.role === "user") lastUserIdx = i;
      });
      if (lastUserIdx >= 0 && result.spill.length > 0) {
        const original = messages[lastUserIdx];
        const form = fitted[fitted.length - 1];
        const w = `${where} — last user`;
        expect(form.role, w).toBe("user");
        if (form !== original) {
          const entry = result.spill.find((s) => s.message === original);
          expect(entry, `${w} not spilled`).toBeDefined();
          expect(entry!.reason, w).toBe("middle-cut");
          if (form.content !== "") expectProperCut(form, original, w);
        }
      }

      // Every message absent from the result (identity) is spilled, with its
      // original index and the full original message; spill entries are valid.
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
      for (const s of result.spill) {
        expect(s.index, where).toBeGreaterThanOrEqual(0);
        expect(s.index, where).toBeLessThan(messages.length);
        expect(s.message, where).toBe(messages[s.index]);
        expect(["dropped-oldest", "middle-cut"], where).toContain(s.reason);
      }

      // Markers only ever come from middle-cuts (shells carry none).
      const markers = fitted.reduce(
        (n, m) => n + [...m.content.matchAll(MARKER_RE)].length,
        0,
      );
      const cuts = result.spill.filter((s) => s.reason === "middle-cut").length;
      expect(markers, `${where} — marker without a middle-cut spill entry`).toBeLessThanOrEqual(
        cuts,
      );

      // Droppables (non-system, non-last-user) that survive form a contiguous
      // suffix in original order: what is dropped is exactly the oldest.
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

    // The generated corpus must actually exercise the final resort.
    expect(sawSystemCut).toBeGreaterThan(0);
  });
});
