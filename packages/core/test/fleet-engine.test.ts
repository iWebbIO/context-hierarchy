// FleetEngine tests (task-5 brief R3) — scripted recording fakes, a REAL
// TokenAccountant, the deterministic TruncationStrategy, and temp dataDirs.
// Nothing here touches the network: the fake adapter records every call and
// answers from a script.
//
// Call classification (the adapter only sees params; roles are inferred from
// the shapes the engine builds):
//   worker       — carries the verbatim WORKER_INSTRUCTION message
//   planner      — max_tokens 500 (the engine's planner budget)
//   synthesizer  — contains a "[digest 1]" wrap
//   direct       — everything else (passthrough, degraded)

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countTokens, FleetEngine, TokenAccountant, TruncationStrategy } from "../src/index.js";
import type {
  ChatMessage,
  ChatParams,
  ChatResult,
  ProviderAdapter,
  StreamEvent,
  SubCallEvent,
} from "../src/index.js";

const MODEL = "fleet-test-model";

// The worker instruction, VERBATIM from the task-5 brief — matching on the
// exact string both classifies calls and pins the text the engine must send.
const WORKER_INSTRUCTION =
  "Compress your assigned slice into a dense digest. Preserve verbatim: code, quotes, paths, ids, numbers, decisions. Plain text only.";

// Deterministic content builder (same convention as the other suites).
function text(words: number, word = "lorem"): string {
  return Array.from({ length: words }, () => word).join(" ");
}

/** system + N alternating middle messages + a final user message. */
function conversation(middleCount: number, wordsPerMessage: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are the fleet test assistant.\nAnswer carefully." },
  ];
  for (let i = 0; i < middleCount; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `middle-${i}: ${text(wordsPerMessage)}`,
    });
  }
  messages.push({ role: "user", content: `the final question: ${text(wordsPerMessage)}` });
  return messages;
}

type CallRole = "planner" | "worker" | "synthesizer" | "direct";

function callRole(params: ChatParams): CallRole {
  if (params.messages.some((m) => m.content === WORKER_INSTRUCTION)) return "worker";
  if (params.max_tokens === 500) return "planner";
  if (params.messages.some((m) => m.content.includes("[digest 1]"))) return "synthesizer";
  return "direct";
}

/** Recording fake adapter: every chat/stream call is recorded, then scripted. */
class FakeAdapter {
  readonly calls: ChatParams[] = [];

  constructor(
    private readonly onChat: (params: ChatParams) => ChatResult | Promise<ChatResult>,
    private readonly onStream: (params: ChatParams) => StreamEvent[],
  ) {}

  async chat(params: ChatParams): Promise<ChatResult> {
    this.calls.push(params);
    return this.onChat(params);
  }

  async *stream(params: ChatParams): AsyncGenerator<StreamEvent> {
    this.calls.push(params);
    for (const event of this.onStream(params)) yield event;
  }
}

interface FleetScriptOptions {
  plannerContent: string;
  /** Digest text a worker returns; default distinguishes slices by first message. */
  digestOf?: (params: ChatParams) => string;
  synthContent?: string;
  directResult?: ChatResult;
}

/** A standard fleet script: planner content, worker digests, synthesizer, direct. */
function fleetScript(opts: FleetScriptOptions): (params: ChatParams) => ChatResult {
  return (params) => {
    switch (callRole(params)) {
      case "planner":
        return { content: opts.plannerContent, finishReason: "stop" };
      case "worker": {
        const digestOf =
          opts.digestOf ?? ((p: ChatParams) => `digest(${p.messages[0].content.slice(0, 9)})`);
        return {
          content: digestOf(params),
          finishReason: "stop",
          usage: { promptTokens: 100, completionTokens: 50 },
        };
      }
      case "synthesizer":
        return {
          content: opts.synthContent ?? "synthesized fleet answer",
          finishReason: "stop",
          usage: { promptTokens: 80, completionTokens: 12 },
        };
      default:
        return opts.directResult ?? { content: "direct answer", finishReason: "stop" };
    }
  };
}

// The happy-path planner plan (conversation(8, ·) → middle = indices 1..8).
const HAPPY_PLAN = JSON.stringify([
  { start: 1, end: 4, budgetTokens: 200 },
  { start: 5, end: 8, budgetTokens: 300 },
]);

const dirs: string[] = [];

function makeHarness(opts: {
  adapter: FakeAdapter;
  capTokens: number;
  /** Pass an existing dir to share a cache between engines (it is cleaned once). */
  dataDir?: string;
  maxWorkers?: number;
}): { engine: FleetEngine; events: SubCallEvent[]; dataDir: string; accountant: TokenAccountant } {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "ctxh-fleet-test-"));
  if (opts.dataDir === undefined) dirs.push(dataDir);
  const events: SubCallEvent[] = [];
  const accountant = new TokenAccountant({ dataDir });
  const engine = new FleetEngine({
    adapter: opts.adapter as unknown as ProviderAdapter,
    accountant,
    strategy: new TruncationStrategy(),
    capTokens: opts.capTokens,
    model: MODEL,
    dataDir,
    maxWorkers: opts.maxWorkers,
    onSubCall: (event) => events.push(event),
  });
  return { engine, events, dataDir, accountant };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** The engine cap every over-cap scenario runs with (full estimate ≈ 1.8× this). */
const CAP = 600;

/** Precondition guard: without this the scenario would silently be a passthrough. */
function assertOverCap(accountant: TokenAccountant, messages: ChatMessage[]): number {
  const total = accountant.estimate(messages, MODEL);
  expect(total).toBeGreaterThan(CAP);
  return CAP;
}

function rolesOf(adapter: FakeAdapter): CallRole[] {
  return adapter.calls.map(callRole);
}

describe("FleetEngine.run", () => {
  it("(a) passthrough: a fitting request makes exactly one direct call", async () => {
    const directResult: ChatResult = {
      content: "direct answer",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    };
    const fake = new FakeAdapter(
      fleetScript({ plannerContent: HAPPY_PLAN, directResult }),
      () => [],
    );
    const messages = conversation(1, 8);
    const { engine, events, dataDir, accountant } = makeHarness({ adapter: fake, capTokens: CAP });
    const fullEstimate = accountant.estimate(messages, MODEL);
    expect(fullEstimate).toBeLessThanOrEqual(CAP); // precondition: it fits

    const result = await engine.run({ model: MODEL, messages });

    expect(fake.calls.length).toBe(1); // exactly one call
    expect(callRole(fake.calls[0])).toBe("direct");
    expect(fake.calls[0].messages).toEqual(messages); // untouched passthrough
    expect(result).toEqual(directResult); // includes usage, no degraded flag
    expect(result.degraded).toBeUndefined();
    expect(events).toEqual([
      {
        call: "direct",
        estimatedTokens: fullEstimate,
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: expect.any(Number),
        cacheHit: false,
      },
    ]);
    // A fitting request never touches the distillate cache.
    expect(existsSync(join(dataDir, "cache"))).toBe(false);
  });

  it("(b) the cap invariant: EVERY dispatched call estimates ≤ cap and the response is valid", async () => {
    const fake = new FakeAdapter(
      // Fenced JSON on purpose — the planner parser tolerates the ```json fence.
      fleetScript({ plannerContent: "```json\n" + HAPPY_PLAN + "\n```" }),
      () => [],
    );
    const messages = conversation(8, 100);
    const { engine, accountant } = makeHarness({ adapter: fake, capTokens: CAP });
    const cap = assertOverCap(accountant, messages); // precondition: over cap

    const result = await engine.run({ model: MODEL, messages });

    // Valid fleet result.
    expect(result.content).toBe("synthesized fleet answer");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ promptTokens: 80, completionTokens: 12 });
    expect(result.degraded).toBeUndefined();

    // The fleet ran: planner → 2 workers → synthesizer, no direct call.
    expect(rolesOf(fake)).toEqual(["planner", "worker", "worker", "synthesizer"]);

    // THE CAP INVARIANT: every dispatched message list estimates ≤ cap.
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      const est = accountant.estimate(call.messages, MODEL);
      expect(est).toBeLessThanOrEqual(cap);
    }
  });

  it("(b-shapes) planner/worker/synthesizer prompts match the contract", async () => {
    const fake = new FakeAdapter(fleetScript({ plannerContent: HAPPY_PLAN }), () => []);
    const messages = conversation(8, 100);
    const { engine } = makeHarness({ adapter: fake, capTokens: CAP });
    await engine.run({ model: MODEL, messages });

    const [planner, worker0, worker1, synth] = fake.calls;

    // Planner: TOC + ORIGINAL last user message + instruction, max_tokens 500.
    expect(planner.max_tokens).toBe(500);
    expect(planner.messages.length).toBe(3);
    const tocLines = planner.messages[0].content.split("\n");
    expect(tocLines.length).toBe(messages.length); // one line per message, no embedded newlines
    tocLines.forEach((line, i) => {
      expect(line).toMatch(new RegExp(`^#${i} (system|user|assistant|tool) ~\\d+t: .{0,60}$`));
    });
    expect(planner.messages[1]).toEqual(messages[9]); // the original last user message
    expect(planner.messages[2].content).toContain("JSON array");
    expect(planner.messages[2].content).toContain("budgetTokens");

    // Workers: their assigned VERBATIM slices + the instruction line, with
    // the assigned budgets as max_tokens.
    const instruction = { role: "user", content: WORKER_INSTRUCTION };
    expect(worker0.max_tokens).toBe(200);
    expect(worker0.messages).toEqual([...messages.slice(1, 5), instruction]);
    expect(worker1.max_tokens).toBe(300);
    expect(worker1.messages).toEqual([...messages.slice(5, 9), instruction]);

    // Synthesizer: [system] + [wrapped digests] + [original last user, last],
    // with max_tokens unset (model default).
    const digest0 = `digest(${messages[1].content.slice(0, 9)})`;
    const digest1 = `digest(${messages[5].content.slice(0, 9)})`;
    expect(synth.max_tokens).toBeUndefined();
    expect(synth.messages.length).toBe(3);
    expect(synth.messages[0]).toEqual(messages[0]);
    expect(synth.messages[1]).toEqual({
      role: "user",
      content: `[digest 1]\n${digest0}\n]\n[digest 2]\n${digest1}\n]`,
    });
    expect(synth.messages[2]).toEqual(messages[9]);
  });

  it("(c) planner garbage → fixed map-reduce fallback still completes", async () => {
    const fake = new FakeAdapter(
      fleetScript({ plannerContent: "I cannot help with planning, sorry." }),
      () => [],
    );
    const messages = conversation(8, 100);
    const { engine, accountant } = makeHarness({ adapter: fake, capTokens: CAP });
    const cap = assertOverCap(accountant, messages);

    const result = await engine.run({ model: MODEL, messages });

    expect(result.content).toBe("synthesized fleet answer");
    expect(result.degraded).toBeUndefined();
    const roles = rolesOf(fake);
    expect(roles[0]).toBe("planner"); // the planner call happened (and failed to parse)
    expect(roles[roles.length - 1]).toBe("synthesizer");
    expect(roles).not.toContain("direct");

    // Map-reduce shape: equal-by-count consecutive chunks covering the middle.
    const workerCalls = fake.calls.filter((c) => callRole(c) === "worker");
    expect(workerCalls.length).toBeGreaterThanOrEqual(2);
    const sizes = workerCalls.map((c) => c.messages.length - 1); // minus the instruction
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    const slicesInOrder = workerCalls.flatMap((c) => c.messages.slice(0, -1));
    expect(slicesInOrder).toEqual(messages.slice(1, 9)); // the whole middle, in order
    for (const call of workerCalls) {
      expect(call.max_tokens).toBe(1000); // default budget
      expect(accountant.estimate(call.messages, MODEL)).toBeLessThanOrEqual(cap);
    }
  });

  it("(c-error) an adapter ERROR on the planner call also takes the map-reduce fallback (no degradation)", async () => {
    // R2: "On ANY planner failure (error, unparseable, empty) → fixed map-reduce
    // fallback" — a thrown planner call is no exception. Only the planner
    // role fails here; the fleet must still complete, undegraded. (A fake that
    // fails the whole fleet path is case (g) below.)
    const fake = new FakeAdapter(
      (params) => {
        if (callRole(params) === "planner") throw new Error("planner upstream error (scripted)");
        return fleetScript({ plannerContent: HAPPY_PLAN })(params);
      },
      () => [],
    );
    const messages = conversation(8, 100);
    const { engine, accountant } = makeHarness({ adapter: fake, capTokens: CAP });
    const cap = assertOverCap(accountant, messages);

    const result = await engine.run({ model: MODEL, messages });

    expect(result.content).toBe("synthesized fleet answer");
    expect(result.degraded).toBeUndefined();
    const roles = rolesOf(fake);
    expect(roles[0]).toBe("planner");
    expect(roles.filter((r) => r === "worker").length).toBeGreaterThanOrEqual(2);
    expect(roles[roles.length - 1]).toBe("synthesizer");
    for (const call of fake.calls) {
      expect(accountant.estimate(call.messages, MODEL)).toBeLessThanOrEqual(cap);
    }
  });

  it("workers run with at most maxWorkers in flight, digests collected in region order", async () => {
    // Four planner-assigned slices under maxWorkers: 2 → at most 2 workers
    // ever in flight (observed via in-flight tracking in the fake), and the
    // default budget applies per worker.
    const fourSlices = JSON.stringify([
      { start: 1, end: 2, budgetTokens: 100 },
      { start: 3, end: 4, budgetTokens: 100 },
      { start: 5, end: 6, budgetTokens: 100 },
      { start: 7, end: 8, budgetTokens: 100 },
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const fake = new FakeAdapter(
      async (params) => {
        if (callRole(params) !== "worker") return fleetScript({ plannerContent: fourSlices })(params);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5)); // make overlap observable
        inFlight--;
        return fleetScript({ plannerContent: fourSlices })(params);
      },
      () => [],
    );
    const messages = conversation(8, 100);
    const { engine, accountant } = makeHarness({ adapter: fake, capTokens: CAP, maxWorkers: 2 });
    assertOverCap(accountant, messages);

    const result = await engine.run({ model: MODEL, messages });

    expect(result.degraded).toBeUndefined();
    const workerCalls = fake.calls.filter((c) => callRole(c) === "worker");
    expect(workerCalls.length).toBe(4);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    // Digests in region order: the synthesizer's wrapped digests follow the
    // slice order (message 1 first).
    const synth = fake.calls.find((c) => callRole(c) === "synthesizer") as ChatParams;
    const block = synth.messages[1].content as string;
    const first = block.indexOf("[digest 1]");
    const last = block.indexOf("[digest 4]");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    expect(block.indexOf(`digest(${messages[1].content.slice(0, 9)})`)).toBeLessThan(
      block.indexOf(`digest(${messages[7].content.slice(0, 9)})`),
    );
  });

  it("(d) cache: an identical oversized request replays with ZERO fleet dispatches", async () => {
    const fake = new FakeAdapter(fleetScript({ plannerContent: HAPPY_PLAN }), () => []);
    const messages = conversation(8, 100);
    const { engine, events, dataDir, accountant } = makeHarness({ adapter: fake, capTokens: CAP });
    assertOverCap(accountant, messages);

    const first = await engine.run({ model: MODEL, messages });
    expect(first.degraded).toBeUndefined();
    const callsAfterFirst = fake.calls.length;
    expect(rolesOf(fake)).toEqual(["planner", "worker", "worker", "synthesizer"]);

    const second = await engine.run({ model: MODEL, messages });

    // ZERO new dispatches of any kind — the replay made no adapter call.
    expect(fake.calls.length).toBe(callsAfterFirst);
    expect(second.content).toBe(first.content);
    expect(second.finishReason).toBe(first.finishReason);
    expect(second.usage).toEqual(first.usage);
    expect(second.degraded).toBeUndefined();

    // Exactly one new onSubCall event: the direct-shaped cache-hit marker.
    const cacheHitEvents = events.filter((e) => e.cacheHit);
    expect(cacheHitEvents.length).toBe(1);
    expect(cacheHitEvents[0]).toEqual({
      call: "direct",
      estimatedTokens: accountant.estimate(messages, MODEL),
      promptTokens: 80,
      completionTokens: 12,
      latencyMs: expect.any(Number),
      cacheHit: true,
    });

    // A different oversized request misses the cache and fleets again.
    const mutated = messages.map((m, i) =>
      i === 3 ? { ...m, content: m.content + " mutated" } : m,
    );
    await engine.run({ model: MODEL, messages: mutated });
    expect(fake.calls.length).toBe(callsAfterFirst + 4);
  });

  it("(f) a worker slice that overflows the cap is strategy-fitted, never a nested fleet", async () => {
    // The planner assigns the ENTIRE middle to one worker → the slice alone
    // overflows the cap → the dispatch funnel must fit it before dispatch.
    const oneBigSlice = JSON.stringify([{ start: 1, end: 8, budgetTokens: 500 }]);
    const fake = new FakeAdapter(fleetScript({ plannerContent: oneBigSlice }), () => []);
    const messages = conversation(8, 100);
    const { engine, accountant } = makeHarness({ adapter: fake, capTokens: CAP });
    const cap = assertOverCap(accountant, messages);

    const result = await engine.run({ model: MODEL, messages });

    expect(result.content).toBe("synthesized fleet answer");
    expect(result.degraded).toBeUndefined();
    // Exactly one planner, one worker, one synthesizer — the oversized slice
    // was fitted INSIDE the worker dispatch; no recursive engine behavior.
    expect(rolesOf(fake)).toEqual(["planner", "worker", "synthesizer"]);

    const worker = fake.calls[1];
    expect(worker.max_tokens).toBe(500); // the assigned budget
    expect(worker.messages.length).toBeLessThan(9); // 8 slice messages + instruction, minus what the fit dropped
    expect(worker.messages[worker.messages.length - 1].content).toBe(WORKER_INSTRUCTION);
    expect(accountant.estimate(worker.messages, MODEL)).toBeLessThanOrEqual(cap);
    // Everything besides the instruction is a VERBATIM original message.
    const originals = new Set(messages.map((m) => JSON.stringify(m)));
    for (const m of worker.messages.slice(0, -1)) {
      expect(originals.has(JSON.stringify(m))).toBe(true);
    }
  });

  it("(g) degradation: fleet-role failures → one direct call, result marked degraded", async () => {
    // The fake throws for every fleet role (the planner failure alone would
    // trigger the map-reduce fallback, so the workers fail too — that is the
    // fleet failure degradation exists for) and answers direct calls.
    const fake = new FakeAdapter(
      (params) => {
        if (callRole(params) !== "direct") throw new Error("upstream fleet call failed (scripted)");
        return { content: "degraded but honest answer", finishReason: "stop" };
      },
      () => {
        throw new Error("must not stream");
      },
    );
    const messages = conversation(8, 100);
    const { engine, events, accountant } = makeHarness({ adapter: fake, capTokens: CAP });
    const cap = assertOverCap(accountant, messages);

    const result = await engine.run({ model: MODEL, messages });

    expect(result.content).toBe("degraded but honest answer");
    expect(result.finishReason).toBe("stop");
    expect(result.degraded).toBe(true);

    const roles = rolesOf(fake);
    expect(roles.filter((r) => r === "direct").length).toBe(1); // exactly one direct call
    expect(roles).not.toContain("synthesizer");
    expect(roles.filter((r) => r === "planner").length).toBe(1);
    expect(roles.filter((r) => r === "worker").length).toBeGreaterThanOrEqual(1); // the fallback ran and failed

    // The degraded direct call was strategy-fitted: under the cap, and NOT
    // the original over-cap request.
    const direct = fake.calls.find((c) => callRole(c) === "direct") as ChatParams;
    expect(accountant.estimate(direct.messages, MODEL)).toBeLessThanOrEqual(cap);
    expect(direct.messages).not.toEqual(messages);

    // Only the completed direct call emitted an event.
    expect(events).toEqual([
      {
        call: "direct",
        estimatedTokens: expect.any(Number),
        latencyMs: expect.any(Number),
        cacheHit: false,
      },
    ]);
    expect(events[0].estimatedTokens).toBeLessThanOrEqual(cap);
  });

  it("(h) onSubCall events carry the correct call labels and fields", async () => {
    const fake = new FakeAdapter(fleetScript({ plannerContent: HAPPY_PLAN }), () => []);
    const messages = conversation(8, 100);
    const { engine, events, accountant } = makeHarness({ adapter: fake, capTokens: CAP });
    const cap = assertOverCap(accountant, messages);

    await engine.run({ model: MODEL, messages });

    expect(events.map((e) => e.call)).toEqual(["planner", "worker", "worker", "synthesizer"]);
    for (const event of events) {
      expect(event.cacheHit).toBe(false);
      expect(event.latencyMs).toBeGreaterThanOrEqual(0);
      expect(event.estimatedTokens).toBeLessThanOrEqual(cap);
      expect(event.estimatedTokens).toBeGreaterThan(0);
    }
    // Usage mapped from each result: workers report 100/50, synthesizer 80/12,
    // the planner script returned no usage at all.
    expect(events[0].promptTokens).toBeUndefined();
    for (const event of events.slice(1, 3)) {
      expect(event.promptTokens).toBe(100);
      expect(event.completionTokens).toBe(50);
    }
    expect(events[3].promptTokens).toBe(80);
    expect(events[3].completionTokens).toBe(12);
  });
});

describe("FleetEngine.stream", () => {
  it("(e) an oversized stream yields delta events then finish; the replay chunks ~20 tokens", async () => {
    const streamContent = text(60); // well above one 20-token replay chunk
    const synthStream: StreamEvent[] = [
      { type: "delta", content: streamContent.slice(0, 20) },
      { type: "delta", content: streamContent.slice(20) },
      { type: "finish", finishReason: "stop", usage: { promptTokens: 42, completionTokens: 60 } },
    ];
    const fake = new FakeAdapter(fleetScript({ plannerContent: HAPPY_PLAN }), () => synthStream);
    const messages = conversation(8, 100);
    const { engine, dataDir, accountant } = makeHarness({ adapter: fake, capTokens: CAP });
    const cap = assertOverCap(accountant, messages);

    const collected: StreamEvent[] = [];
    for await (const event of engine.stream({ model: MODEL, messages })) collected.push(event);

    expect(rolesOf(fake)).toEqual(["planner", "worker", "worker", "synthesizer"]);
    const deltas = collected.filter((e) => e.type === "delta");
    expect(deltas.length).toBe(2);
    expect(deltas.map((e) => (e as { content?: string }).content).join("")).toBe(streamContent);
    const finish = collected[collected.length - 1];
    expect(finish).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 42, completionTokens: 60 },
    });
    for (const call of fake.calls) {
      expect(accountant.estimate(call.messages, MODEL)).toBeLessThanOrEqual(cap);
    }

    // Second identical stream: replayed from the distillate with ZERO adapter
    // calls (the fake throws if the engine dares call it). Same dataDir →
    // same cache; a fresh engine proves the replay needs no in-memory state.
    const boom = new FakeAdapter(
      () => {
        throw new Error("no adapter call expected on a cache hit");
      },
      () => {
        throw new Error("no adapter stream expected on a cache hit");
      },
    );
    const replay = makeHarness({ adapter: boom, capTokens: CAP, dataDir });
    const replayed: StreamEvent[] = [];
    for await (const event of replay.engine.stream({ model: MODEL, messages })) replayed.push(event);

    expect(boom.calls.length).toBe(0);
    const replayDeltas = replayed.filter((e) => e.type === "delta") as { content?: string }[];
    expect(replayDeltas.length).toBeGreaterThan(1); // chunked, not one blob
    for (const delta of replayDeltas) {
      expect(countTokens(delta.content ?? "")).toBeLessThanOrEqual(30); // ~20-token chunks
    }
    expect(replayDeltas.map((d) => d.content ?? "").join("")).toBe(streamContent);
    expect(replayed[replayed.length - 1]).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 42, completionTokens: 60 },
    });
    expect(replay.events).toEqual([
      {
        call: "direct",
        estimatedTokens: accountant.estimate(messages, MODEL),
        promptTokens: 42,
        completionTokens: 60,
        latencyMs: expect.any(Number),
        cacheHit: true,
      },
    ]);
  });

  it("a fitting stream passes the adapter's events through untouched", async () => {
    const passthrough: StreamEvent[] = [
      { type: "delta", content: "hi " },
      { type: "delta", content: "there" },
      { type: "finish", finishReason: "stop" },
    ];
    const fake = new FakeAdapter(
      () => {
        throw new Error("chat must not be called on a stream passthrough");
      },
      () => passthrough,
    );
    const messages = conversation(1, 8);
    const { engine, events, accountant } = makeHarness({ adapter: fake, capTokens: CAP });
    expect(accountant.estimate(messages, MODEL)).toBeLessThanOrEqual(CAP);

    const collected: StreamEvent[] = [];
    for await (const event of engine.stream({ model: MODEL, messages })) collected.push(event);

    expect(collected).toEqual(passthrough);
    expect(fake.calls.length).toBe(1);
    expect(events).toEqual([
      {
        call: "direct",
        estimatedTokens: accountant.estimate(messages, MODEL),
        latencyMs: expect.any(Number),
        cacheHit: false,
      },
    ]);
  });
});
