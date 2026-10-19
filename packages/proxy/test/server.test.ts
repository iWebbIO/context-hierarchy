// Proxy server tests (task-6 brief R6): REAL FleetEngine over a scripted
// fake adapter, temp dataDirs, everything through fastify.inject() — zero
// network. Scenarios (a)–(h) from the brief.
//
// Fake-adapter scripts classify calls the same way the fleet-engine tests
// do: worker (carries the verbatim worker instruction), planner
// (max_tokens 500), synthesizer (contains "[digest 1]"), direct (rest).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  FleetEngine,
  TokenAccountant,
  TruncationStrategy,
  UpstreamError,
} from "@context-hierarchy/core";
import type {
  ChatParams,
  ChatResult,
  ProviderAdapter,
  StreamEvent,
} from "@context-hierarchy/core";
import { buildServer, subCallSink } from "../src/index.js";
import type { ProxyConfig } from "../src/index.js";
import { Telemetry } from "../src/index.js";

const MODEL = "proxy-test-model";

// VERBATIM from the engine (packages/core/src/fleet-engine.ts WORKER_INSTRUCTION).
const WORKER_INSTRUCTION =
  "Compress your assigned slice into a dense digest. Preserve verbatim: code, quotes, paths, ids, numbers, decisions. Plain text only.";

/** Deterministic filler text. */
function text(words: number, word = "lorem"): string {
  return Array.from({ length: words }, () => word).join(" ");
}

/** system + N alternating middle messages + a final user message. */
function conversation(middleCount: number, wordsPerMessage: number): ChatParams["messages"] {
  const messages = [{ role: "system", content: "You are the proxy test assistant." }];
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

// Named wire-chunk shapes for casts (oxc's parser rejects the inline
// object-literal forms with nested generics).
interface WireDelta {
  role?: string;
  content?: string;
  tool_calls?: unknown[];
}
interface WireChoice {
  index: number;
  delta: WireDelta;
  finish_reason?: string | null;
}
interface WireChunk {
  id: string;
  object: string;
  model: string;
  choices: WireChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function callRole(params: ChatParams): CallRole {
  if (params.messages.some((m) => m.content === WORKER_INSTRUCTION)) return "worker";
  if (params.max_tokens === 500) return "planner";
  if (params.messages.some((m) => m.content.includes("[digest 1]"))) return "synthesizer";
  return "direct";
}

/** Recording fake adapter: every call recorded, then scripted. */
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

  async models(): Promise<unknown> {
    return { object: "list", data: [{ id: "fake-model", object: "model" }] };
  }
}

// A planner plan for conversation(8, ·): two slices over middle indices 1..8.
const TWO_SLICES = JSON.stringify([
  { start: 1, end: 4, budgetTokens: 200 },
  { start: 5, end: 8, budgetTokens: 300 },
]);

interface Harness {
  app: FastifyInstance;
  adapter: FakeAdapter;
  telemetry: Telemetry;
  dataDir: string;
  close(): Promise<void>;
}

const dirs: string[] = [];
const apps: FastifyInstance[] = [];

/** REAL engine + REAL accountant + REAL strategy + fake adapter, temp dataDir. */
function makeHarness(opts: {
  onChat: (params: ChatParams) => ChatResult | Promise<ChatResult>;
  onStream?: (params: ChatParams) => StreamEvent[];
  capTokens?: number;
  proxyApiKey?: string;
}): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "ctxh-proxy-test-"));
  dirs.push(dataDir);
  const adapter = new FakeAdapter(opts.onChat, opts.onStream ?? (() => []));
  const telemetry = new Telemetry(join(dataDir, "telemetry.jsonl"));
  const engine = new FleetEngine({
    adapter: adapter as unknown as ProviderAdapter,
    accountant: new TokenAccountant({ dataDir }),
    strategy: new TruncationStrategy(),
    capTokens: opts.capTokens ?? 600,
    model: MODEL,
    dataDir,
    onSubCall: subCallSink(telemetry),
  });
  const cfg: ProxyConfig = {
    upstreamBaseUrl: "https://fake.example/v1",
    upstreamApiKey: "unused",
    upstreamModel: MODEL,
    capTokens: opts.capTokens ?? 600,
    port: 0,
    strategy: "hierarchy",
    concurrency: 3,
    dataDir,
    proxyApiKey: opts.proxyApiKey ?? "",
  };
  const app = buildServer({
    adapter: adapter as unknown as ProviderAdapter,
    engine,
    telemetry,
    cfg,
  });
  apps.push(app);
  return { app, adapter, telemetry, dataDir, close: () => app.close() };
}

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** POST /v1/chat/completions with a JSON body. */
function chat(app: FastifyInstance, body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json", ...headers },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Parse the SSE payload objects out of a response body (skips [DONE]). */
function ssePayloads(body: string): unknown[] {
  const out: unknown[] = [];
  for (const part of body.split(/data: /)) {
    const payload = part.split("\n")[0].trim();
    if (payload === "" || payload === "[DONE]") continue;
    out.push(JSON.parse(payload));
  }
  return out;
}

/** All content strings of a chunk list, concatenated. */
function joinedContent(chunks: WireChunk[]): string {
  let out = "";
  for (const c of chunks) {
    for (const choice of c.choices) out += choice.delta.content ?? "";
  }
  return out;
}

/** The chunk list narrowed from ssePayloads' unknowns. */
function wireChunks(payloads: unknown[]): WireChunk[] {
  return payloads as WireChunk[];
}

// The engine cap every over-cap scenario runs with (full estimate ≈ 1.8× this).
const CAP = 600;

describe("POST /v1/chat/completions — non-stream", () => {
  it("(a) small request passthrough: OpenAI shape, usage present, telemetry logged", async () => {
    const directResult: ChatResult = {
      content: "a small direct answer",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    };
    const h = makeHarness({ onChat: () => directResult });
    const messages = conversation(1, 8);

    const res = await chat(h.app, { model: "ignored-model", messages });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe(MODEL);
    expect(body.created).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(body.choices).toEqual([
      {
        index: 0,
        message: { role: "assistant", content: "a small direct answer" },
        finish_reason: "stop",
      },
    ]);
    // Synthetic usage = the passthrough call's own usage.
    expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(res.headers["x-context-hierarchy-degraded"]).toBeUndefined();

    // Exactly one adapter call — the original request, untouched.
    expect(h.adapter.calls.length).toBe(1);
    expect(callRole(h.adapter.calls[0])).toBe("direct");
    expect(h.adapter.calls[0].messages).toEqual(messages);
    expect(h.adapter.calls[0].model).toBe(MODEL); // proxy routes to UPSTREAM_MODEL

    // Telemetry: one http line + one subcall line.
    const entries = h.telemetry.entries() as Array<Record<string, unknown>>;
    expect(entries.filter((e) => e.kind === "http")).toEqual([
      {
        kind: "http",
        ts: expect.any(String),
        path: "/v1/chat/completions",
        stream: false,
        status: 200,
        latencyMs: expect.any(Number),
      },
    ]);
    const subcalls = entries.filter((e) => e.kind === "subcall");
    expect(subcalls).toEqual([
      {
        kind: "subcall",
        ts: expect.any(String),
        call: "direct",
        estimatedTokens: expect.any(Number),
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: expect.any(Number),
        cacheHit: false,
      },
    ]);
  });

  it("(b) oversized request: fleet engaged, valid response, every sub-call ≤ cap", async () => {
    const h = makeHarness({
      onChat: (params) => {
      switch (callRole(params)) {
        case "planner":
          return { content: TWO_SLICES, finishReason: "stop" };
        case "worker":
          return {
            content: `digest(${params.messages[0].content.slice(0, 9)})`,
            finishReason: "stop",
            usage: { promptTokens: 100, completionTokens: 50 },
          };
        case "synthesizer":
          return {
            content: "the synthesized fleet answer",
            finishReason: "stop",
            usage: { promptTokens: 80, completionTokens: 12 },
          };
        default:
          return { content: "should not be reached", finishReason: "stop" };
      }
      },
    });
    const messages = conversation(8, 100);
    const accountant = new TokenAccountant({ dataDir: h.dataDir });
    expect(accountant.estimate(messages, MODEL)).toBeGreaterThan(CAP); // precondition

    const res = await chat(h.app, { messages });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      object: "chat.completion",
      model: MODEL,
      choices: [
        { index: 0, message: { role: "assistant", content: "the synthesized fleet answer" }, finish_reason: "stop" },
      ],
    });
    // The fleet ran: planner → 2 workers → synthesizer, no direct call.
    expect(h.adapter.calls.map(callRole)).toEqual([
      "planner",
      "worker",
      "worker",
      "synthesizer",
    ]);
    // SYNTHETIC usage, summed across ALL sub-calls: the planner reported no
    // usage, so its ESTIMATE is counted (fallback rule), plus workers
    // 100/50 each + synthesizer 80/12.
    const subcalls = h.telemetry
      .entries()
      .filter((e) => (e as Record<string, unknown>).kind === "subcall") as Array<
      Record<string, unknown>
    >;
    const plannerEstimate = subcalls.find((e) => e.call === "planner")?.estimatedTokens as number;
    expect(res.json().usage).toEqual({
      prompt_tokens: plannerEstimate + 280, // planner estimate + 100 + 100 + 80
      completion_tokens: 112, // 50 + 50 + 12
      total_tokens: plannerEstimate + 392,
    });
    // Every sub-call in telemetry estimates ≤ cap (cache-replay markers aside,
    // there are none here — first request).
    expect(subcalls.length).toBe(4);
    for (const event of subcalls) {
      expect(event.estimatedTokens).toBeLessThanOrEqual(CAP);
      expect(event.cacheHit).toBe(false);
    }
    // And every DISPATCHED message list fits the cap (cap invariant).
    for (const call of h.adapter.calls) {
      expect(accountant.estimate(call.messages, MODEL)).toBeLessThanOrEqual(CAP);
    }
  });

  it("tool_calls on a non-stream result are mapped to the wire shape", async () => {
    const h = makeHarness({
      onChat: () => ({
        content: "",
        toolCalls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Berlin\"}" } },
        ],
        finishReason: "tool_calls",
        usage: { promptTokens: 9, completionTokens: 3 },
      }),
    });

    const res = await chat(h.app, { messages: [{ role: "user", content: "weather?" }] });

    expect(res.statusCode).toBe(200);
    const message = res.json().choices[0].message;
    expect(message.role).toBe("assistant");
    expect(message.content).toBe("");
    expect(message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: "{\"city\":\"Berlin\"}" },
      },
    ]);
    expect(res.json().choices[0].finish_reason).toBe("tool_calls");
  });

  it("(e) degraded: fleet failure → 200 with x-context-hierarchy-degraded: true", async () => {
    const h = makeHarness({
      onChat: (params) => {
        if (callRole(params) !== "direct") {
          throw new Error("scripted fleet failure");
        }
        return { content: "degraded but honest answer", finishReason: "stop" };
      },
    });
    const messages = conversation(8, 100);

    const res = await chat(h.app, { messages });

    expect(res.statusCode).toBe(200); // never a 5xx from cap logic
    expect(res.headers["x-context-hierarchy-degraded"]).toBe("true");
    expect(res.json().choices[0].message.content).toBe("degraded but honest answer");
    // The degraded path made exactly one direct call (fitted under the cap).
    const directCalls = h.adapter.calls.filter((c) => callRole(c) === "direct");
    expect(directCalls.length).toBe(1);
  });

  it("a real UpstreamError passes its status through with an OpenAI-style body", async () => {
    const h = makeHarness({
      onChat: () => {
        throw new UpstreamError("upstream quota exceeded", 429);
      },
    });

    const res = await chat(h.app, { messages: [{ role: "user", content: "hi" }] });

    expect(res.statusCode).toBe(429); // the upstream's own status, passed through
    expect(res.json()).toEqual({
      error: { message: "upstream quota exceeded", type: "api_error" },
    });
  });

  it("an UpstreamError without a status defaults to 502", async () => {
    const h = makeHarness({
      onChat: () => {
        throw new UpstreamError("upstream broke in an exotic way");
      },
    });

    const res = await chat(h.app, { messages: [{ role: "user", content: "hi" }] });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: { message: "upstream broke in an exotic way", type: "api_error" },
    });
  });

  it("(h) malformed JSON body → 400 invalid_request_error", async () => {
    const h = makeHarness({ onChat: () => ({ content: "x", finishReason: "stop" }) });

    const res = await chat(h.app, "{not json");

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
    expect(typeof res.json().error.message).toBe("string");
    expect(h.adapter.calls.length).toBe(0);
  });

  it("a body missing `messages` (or with a bad one) → 400 invalid_request_error", async () => {
    const h = makeHarness({ onChat: () => ({ content: "x", finishReason: "stop" }) });

    const noMessages = await chat(h.app, { model: "m" });
    expect(noMessages.statusCode).toBe(400);
    expect(noMessages.json().error.type).toBe("invalid_request_error");

    const badRole = await chat(h.app, { messages: [{ role: "wizard", content: "hi" }] });
    expect(badRole.statusCode).toBe(400);
    expect(h.adapter.calls.length).toBe(0);
  });

  it("(f) PROXY_API_KEY gate: 401 without the header, 200 with it", async () => {
    const h = makeHarness({
      onChat: () => ({ content: "gated answer", finishReason: "stop" }),
      proxyApiKey: "secret-gate",
    });
    const messages = [{ role: "user", content: "hi" }];

    const without = await chat(h.app, { messages });
    expect(without.statusCode).toBe(401);
    expect(without.json().error.type).toBe("invalid_request_error");

    const withKey = await chat(h.app, { messages }, { authorization: "Bearer secret-gate" });
    expect(withKey.statusCode).toBe(200);
    expect(withKey.json().choices[0].message.content).toBe("gated answer");
  });

  it("tool-bearing requests pass tools through to the adapter", async () => {
    const tools = [{ type: "function", function: { name: "f", parameters: {} } }];
    const h = makeHarness({ onChat: () => ({ content: "ok", finishReason: "stop" }) });

    const res = await chat(h.app, {
      messages: [{ role: "user", content: "use the tool" }],
      tools,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 100,
    });

    expect(res.statusCode).toBe(200);
    const call = h.adapter.calls[0];
    expect(call.tools).toEqual(tools);
    expect(call.tool_choice).toBe("auto");
    expect(call.temperature).toBe(0.2);
    expect(call.max_tokens).toBe(100);
  });

  it("a tool-calling second turn (assistant content: null + tool_calls echoed back) is accepted", async () => {
    // The OpenAI wire convention: an assistant tool-call message carries
    // `content: null`, and clients echo it back in the history for turn 2.
    // The proxy coerces null → "" locally; the round-trip must not 400.
    const h = makeHarness({
      onChat: () => ({ content: "the weather is sunny", finishReason: "stop" }),
    });
    const history = [
      { role: "user", content: "weather in Berlin?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{\"city\":\"Berlin\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "{\"temp\": 21}" },
    ];

    const res = await chat(h.app, { messages: history });

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe("the weather is sunny");
    // The dispatched history: content coerced to "", tool_calls and the tool
    // message intact (the null never reaches core's string-typed ChatMessage).
    expect(h.adapter.calls.length).toBe(1);
    const sent = h.adapter.calls[0].messages;
    expect(sent[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: "{\"city\":\"Berlin\"}" },
        },
      ],
    });
    expect(sent[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "{\"temp\": 21}" });
  });

  it("content that is neither a string nor null is still rejected", async () => {
    const h = makeHarness({ onChat: () => ({ content: "x", finishReason: "stop" }) });

    const numeric = await chat(h.app, { messages: [{ role: "user", content: 42 }] });
    expect(numeric.statusCode).toBe(400);
    expect(numeric.json().error.type).toBe("invalid_request_error");
    expect(h.adapter.calls.length).toBe(0);
  });
});

describe("POST /v1/chat/completions — stream", () => {
  /** The synthesizer's scripted SSE stream. */
  const SYNTH_STREAM: StreamEvent[] = [
    { type: "delta", content: "Hello" },
    { type: "delta", content: " world" },
    { type: "finish", finishReason: "stop", usage: { promptTokens: 42, completionTokens: 7 } },
  ];

  function fleetHarness(onStream?: (params: ChatParams) => StreamEvent[]): Harness {
    return makeHarness({
      onChat: (params) => {
        switch (callRole(params)) {
          case "planner":
            return { content: TWO_SLICES, finishReason: "stop" };
          case "worker":
            return {
              content: `digest(${params.messages[0].content.slice(0, 9)})`,
              finishReason: "stop",
              usage: { promptTokens: 100, completionTokens: 50 },
            };
          default:
            return { content: "unused", finishReason: "stop" };
        }
      },
      onStream:
        onStream ??
        ((params) => {
          if (callRole(params) === "synthesizer") return SYNTH_STREAM;
          return []; // direct passthrough never happens in these scenarios
        }),
    });
  }

  it("(c) oversized stream: role chunk, content deltas, finish, [DONE]; include_usage chunk", async () => {
    const h = fleetHarness();
    const messages = conversation(8, 100);
    const accountant = new TokenAccountant({ dataDir: h.dataDir });
    expect(accountant.estimate(messages, MODEL)).toBeGreaterThan(CAP);

    const res = await chat(h.app, {
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    expect(res.statusCode).toBe(200);
    // SSE headers.
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["connection"]).toBe("keep-alive");
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);

    const payloads = wireChunks(ssePayloads(res.body));
    // First chunk: the role delta.
    expect(payloads[0]).toMatchObject({
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: { role: "assistant" } }],
    });
    // Content deltas.
    expect(joinedContent(payloads)).toBe("Hello world");
    // Finish chunk.
    const finish = payloads[payloads.length - 2];
    expect(finish).toMatchObject({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    // Usage chunk (include_usage): synthetic, summed across sub-calls, empty choices.
    const usage = payloads[payloads.length - 1];
    expect(usage).toMatchObject({ object: "chat.completion.chunk", choices: [] });
    expect(usage.usage).toEqual({
      // planner (no usage → its estimate) + 2×worker 100 + synthesizer 42
      prompt_tokens: expect.any(Number),
      completion_tokens: 107, // 2×50 + 7
      total_tokens: expect.any(Number),
    });
    expect(usage.usage?.total_tokens).toBe((usage.usage?.prompt_tokens ?? 0) + 107);
    // [DONE] terminated the stream.
    expect(res.body).toContain("data: [DONE]");

    // HTTP telemetry recorded the stream flag.
    const http = h.telemetry
      .entries()
      .filter((e) => (e as Record<string, unknown>).kind === "http") as Array<Record<string, unknown>>;
    expect(http[0].stream).toBe(true);
    expect(http[0].status).toBe(200);
  });

  it("(c') stream without include_usage: no usage chunk", async () => {
    const h = fleetHarness();
    const res = await chat(h.app, { messages: conversation(8, 100), stream: true });

    expect(res.statusCode).toBe(200);
    const payloads = ssePayloads(res.body);
    const usageChunks = payloads.filter((p) => "usage" in (p as object));
    expect(usageChunks.length).toBe(0);
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("(d) tool-call deltas: proxy re-chunks with correct index/id/name/arguments", async () => {
    const toolStream: StreamEvent[] = [
      {
        type: "delta",
        toolCallDeltas: [{ index: 0, id: "call_1", functionName: "get_weather", argumentsDelta: "" }],
      },
      { type: "delta", toolCallDeltas: [{ index: 0, argumentsDelta: "{\"ci" }] },
      { type: "delta", toolCallDeltas: [{ index: 0, argumentsDelta: "ty\":\"Berlin\"}" }] },
      { type: "delta", content: "calling the tool" },
      { type: "finish", finishReason: "tool_calls", usage: { promptTokens: 5, completionTokens: 2 } },
    ];
    const h = fleetHarness(() => toolStream);

    const res = await chat(h.app, { messages: conversation(8, 100), stream: true });

    expect(res.statusCode).toBe(200);
    const payloads = wireChunks(ssePayloads(res.body));
    const toolChunks: Array<Array<Record<string, unknown>>> = [];
    for (const p of payloads) {
      const choice = p.choices[0];
      const tc = choice ? choice.delta.tool_calls : undefined;
      if (tc !== undefined) toolChunks.push(tc as Array<Record<string, unknown>>);
    }
    expect(toolChunks.length).toBe(3); // one per tool-call delta event
    // First fragment carries id + type + name (the wire convention the
    // official SDK's aggregator requires); every fragment has the correct index.
    expect(toolChunks[0]).toEqual([
      { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } },
    ]);
    expect(toolChunks[1]).toEqual([{ index: 0, function: { arguments: "{\"ci" } }]);
    expect(toolChunks[2]).toEqual([{ index: 0, function: { arguments: "ty\":\"Berlin\"}" } }]);
    // Content deltas still flow through the same stream.
    expect(joinedContent(payloads)).toContain("calling the tool");
    // Finish carries the tool_calls reason.
    expect(res.body).toContain('"finish_reason":"tool_calls"');
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("a small fitting stream passes through as SSE (role chunk + deltas + finish + [DONE])", async () => {
    const passthrough: StreamEvent[] = [
      { type: "delta", content: "hi " },
      { type: "delta", content: "there" },
      { type: "finish", finishReason: "stop", usage: { promptTokens: 3, completionTokens: 2 } },
    ];
    const h = makeHarness({
      onChat: () => {
        throw new Error("chat must not be called for a stream request");
      },
      onStream: (params) => {
        if (callRole(params) === "direct") return passthrough;
        return [];
      },
    });

    const res = await chat(h.app, { messages: conversation(1, 8), stream: true });

    expect(res.statusCode).toBe(200);
    const payloads = wireChunks(ssePayloads(res.body));
    expect(payloads[0].choices).toEqual([{ index: 0, delta: { role: "assistant" } }]);
    expect(joinedContent(payloads)).toBe("hi there");
    expect(res.body).toContain('"finish_reason":"stop"');
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("a mid-stream error becomes an SSE error line + [DONE] (never a hang)", async () => {
    const h = makeHarness({
      onChat: () => ({ content: "unused", finishReason: "stop" }),
      onStream: () => [
        { type: "delta", content: "partial" },
        { type: "error", message: "upstream exploded mid-stream" },
      ],
    });

    const res = await chat(h.app, { messages: conversation(1, 8), stream: true });

    expect(res.statusCode).toBe(200); // headers were already sent as SSE
    expect(res.body).toContain("upstream exploded mid-stream");
    expect(res.body).toContain('"type":"api_error"');
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("a pre-stream failure (upstream error before the first event) is an SSE error + [DONE]", async () => {
    const h = makeHarness({
      onChat: () => ({ content: "unused", finishReason: "stop" }),
      onStream: () => {
        throw new Error("connection refused before first byte");
      },
    });

    const res = await chat(h.app, { messages: conversation(1, 8), stream: true });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("connection refused before first byte");
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("(e-stream) degraded stream: SSE comment marker + flagged sub-call telemetry + finish_reason", async () => {
    // Fleet fails before the first yield → the stream degrades. Headers are
    // already sent, so the marker rides as an SSE comment line; the finish
    // chunk still carries its finish_reason; the sub-call telemetry event
    // is flagged degraded (constraint 10, streaming path).
    const degradedStream: StreamEvent[] = [
      { type: "delta", content: "degraded " },
      { type: "delta", content: "stream answer" },
      { type: "finish", finishReason: "stop", usage: { promptTokens: 7, completionTokens: 3 }, degraded: true },
    ];
    const h = makeHarness({
      onChat: (params) => {
        if (callRole(params) !== "direct") throw new Error("scripted fleet failure");
        return { content: "unused", finishReason: "stop" };
      },
      onStream: (params) => {
        if (callRole(params) === "direct") return degradedStream;
        throw new Error("scripted fleet stream failure");
      },
    });

    const res = await chat(h.app, { messages: conversation(8, 100), stream: true });

    expect(res.statusCode).toBe(200);
    // The SSE comment marker (headers were already sent; the header cannot be).
    expect(res.body).toContain(": x-context-hierarchy-degraded: true");
    // The degraded answer itself streamed through (as separate delta chunks),
    // and the finish chunk carried its finish_reason (never a null here).
    expect(res.body).toContain('"content":"degraded "');
    expect(res.body).toContain('"content":"stream answer"');
    expect(res.body).toContain('"finish_reason":"stop"');
    expect(res.body).not.toContain('"finish_reason":null');
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
    // Sub-call telemetry carries the degraded flag.
    const subcalls = h.telemetry
      .entries()
      .filter((e) => (e as Record<string, unknown>).kind === "subcall") as Array<
      Record<string, unknown>
    >;
    expect(subcalls.some((e) => e.degraded === true && e.call === "direct")).toBe(true);
  });

  it("(e-stream') a degraded stream WITHOUT a finish synthesizes finish_reason: null (SDK-clean end)", async () => {
    // The degraded direct stream ended without a finish event: the engine
    // synthesizes a degraded finish; the proxy maps its empty reason to null
    // so OpenAI clients see a terminal chunk (the e2e SDK path resolves).
    const h = makeHarness({
      onChat: (params) => {
        if (callRole(params) !== "direct") throw new Error("scripted fleet failure");
        return { content: "unused", finishReason: "stop" };
      },
      onStream: (params) => {
        if (callRole(params) === "direct") return [{ type: "delta", content: "partial" }];
        throw new Error("scripted fleet stream failure");
      },
    });

    const res = await chat(h.app, { messages: conversation(8, 100), stream: true });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(": x-context-hierarchy-degraded: true");
    expect(res.body).toContain('"finish_reason":null');
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});

describe("GET /v1/models", () => {
  it("(g) passes the adapter's models payload through", async () => {
    const h = makeHarness({ onChat: () => ({ content: "x", finishReason: "stop" }) });

    const res = await h.app.inject({ method: "GET", url: "/v1/models" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      object: "list",
      data: [{ id: "fake-model", object: "model" }],
    });
  });

  it("(g') the auth gate covers /v1/models too", async () => {
    const h = makeHarness({
      onChat: () => ({ content: "x", finishReason: "stop" }),
      proxyApiKey: "secret-gate",
    });

    const without = await h.app.inject({ method: "GET", url: "/v1/models" });
    expect(without.statusCode).toBe(401);

    const withKey = await h.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer secret-gate" },
    });
    expect(withKey.statusCode).toBe(200);
  });
});

describe("unknown routes", () => {
  it("404s with an OpenAI-style body", async () => {
    const h = makeHarness({ onChat: () => ({ content: "x", finishReason: "stop" }) });
    const res = await h.app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.type).toBe("invalid_request_error");
  });
});
