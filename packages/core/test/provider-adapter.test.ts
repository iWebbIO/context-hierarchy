// ProviderAdapter tests — every fetch is scripted; nothing here touches the
// network, and nothing here is gated on LIVE (that is live-smoke.test.ts).

import { describe, expect, it } from "vitest";
import { ProviderAdapter, UpstreamError } from "../src/index.js";
import type { ChatParams, StreamEvent } from "../src/index.js";

// Trailing slash on purpose: the adapter must normalize it away.
const BASE_URL = "https://upstream.example/v1/";
const API_KEY = "test-key";

const params: ChatParams = {
  model: "glm-5.3-max",
  messages: [{ role: "user", content: "hello" }],
};

// ─── scripted fetch ─────────────────────────────────────────────────────────

type Recorded = { url: string; init: RequestInit };

type Step =
  | { kind: "response"; response: Response }
  | { kind: "throw"; error: Error }
  | { kind: "hang" }; // never resolves; rejects with AbortError once the adapter aborts

function scriptFetch(steps: Step[]) {
  const calls: Recorded[] = [];
  let next = 0;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = steps[next++];
    if (step === undefined) throw new Error(`unexpected fetch call #${next}`);
    if (step.kind === "response") return step.response;
    if (step.kind === "throw") throw step.error;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("hang step requires an abort signal");
      signal.addEventListener("abort", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  return { calls, fetch };
}

function adapterFor(steps: Step[], timeoutMs = 120_000) {
  const script = scriptFetch(steps);
  const adapter = new ProviderAdapter({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: script.fetch,
    timeoutMs,
  });
  return { adapter, calls: script.calls };
}

// ─── response builders ──────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** SSE body from raw chunk strings; `failAfter` errors the stream mid-body. */
function sseBody(chunks: string[], failAfter?: Error): Response {
  const encoder = new TextEncoder();
  let i = 0;
  // pull-based: each read is fulfilled by one chunk; the failure fires only
  // after every chunk was delivered (enqueue+error inside start() would
  // discard the queued chunks — ReadableStream#error resets the queue).
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else if (failAfter) {
        controller.error(failAfter);
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const DONE = "data: [DONE]\n\n";
const KEEPALIVE = ": openrouter keep-alive comment\n\n";

function sse(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const happyChatResponse = {
  choices: [
    {
      message: {
        content: "Let me check the weather.",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
          { id: "call_b", type: "function", function: { name: "get_time", arguments: '{"tz":"CET"}' } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 42, completion_tokens: 7 },
};

// ─── chat ───────────────────────────────────────────────────────────────────

describe("ProviderAdapter.chat", () => {
  it("aggregates tool_calls and maps usage on the happy path", async () => {
    const fullParams: ChatParams = {
      ...params,
      temperature: 0.2,
      max_tokens: 100,
      tools: [{ type: "function", function: { name: "noop", parameters: {} } }],
      tool_choice: "auto",
    };
    const { adapter, calls } = adapterFor([
      { kind: "response", response: jsonResponse(happyChatResponse) },
    ]);
    const result = await adapter.chat(fullParams);

    expect(result).toStrictEqual({
      content: "Let me check the weather.",
      toolCalls: [
        { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
        { id: "call_b", type: "function", function: { name: "get_time", arguments: '{"tz":"CET"}' } },
      ],
      finishReason: "tool_calls",
      usage: { promptTokens: 42, completionTokens: 7 },
    });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://upstream.example/v1/chat/completions");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.model).toBe("glm-5.3-max");
    expect(body.messages).toStrictEqual(fullParams.messages);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(100);
    expect(body.tools).toStrictEqual(fullParams.tools);
    expect(body.tool_choice).toBe("auto");
    expect("stream_options" in body).toBe(false);
  });

  it("omits optional body and result fields when absent", async () => {
    const { adapter, calls } = adapterFor([
      {
        kind: "response",
        response: jsonResponse({ choices: [{ message: { content: "Hi there" }, finish_reason: "stop" }] }),
      },
    ]);
    const result = await adapter.chat(params);

    expect(result).toStrictEqual({ content: "Hi there", finishReason: "stop" });
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toStrictEqual(["messages", "model", "stream"]);
  });
});

// ─── stream ─────────────────────────────────────────────────────────────────

describe("ProviderAdapter.stream", () => {
  it("yields content deltas, ignores comments, attaches usage to finish (empty-choices usage chunk)", async () => {
    const { adapter, calls } = adapterFor([
      {
        kind: "response",
        response: sseBody([
          sse({ choices: [{ delta: { content: "Hel" } }] }),
          KEEPALIVE,
          sse({ choices: [{ delta: { content: "lo" } }] }),
          sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
          DONE,
        ]),
      },
    ]);
    const events = await collect(adapter.stream(params));

    expect(events).toStrictEqual([
      { type: "delta", content: "Hel" },
      { type: "delta", content: "lo" },
      { type: "finish", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } },
    ]);
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toStrictEqual({ include_usage: true });
  });

  it("attaches usage from a non-empty-choices usage chunk (openrouter dialect)", async () => {
    const { adapter } = adapterFor([
      {
        kind: "response",
        response: sseBody([
          sse({ choices: [{ delta: { content: "Hi" } }] }),
          sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 9, completion_tokens: 2 } }),
          DONE,
        ]),
      },
    ]);
    const events = await collect(adapter.stream(params));

    expect(events).toStrictEqual([
      { type: "delta", content: "Hi" },
      { type: "finish", finishReason: "stop", usage: { promptTokens: 9, completionTokens: 2 } },
    ]);
  });

  it("keys tool-call delta fragments by index so they assemble across chunks", async () => {
    const { adapter } = adapterFor([
      {
        kind: "response",
        response: sseBody([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "get_weather", arguments: '{"ci' } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "get_time", arguments: '["' } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Par' } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'CET"]' } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'is"}' } }] } }] }),
          sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          DONE,
        ]),
      },
    ]);
    const events = await collect(adapter.stream(params));

    expect(events.length).toBe(6);
    expect(events[0]).toStrictEqual({ type: "delta", toolCallDeltas: [{ index: 0, id: "call_a", functionName: "get_weather", argumentsDelta: '{"ci' }] });
    expect(events[1]).toStrictEqual({ type: "delta", toolCallDeltas: [{ index: 1, id: "call_b", functionName: "get_time", argumentsDelta: '["' }] });
    expect(events[2]).toStrictEqual({ type: "delta", toolCallDeltas: [{ index: 0, argumentsDelta: 'ty":"Par' }] });
    expect(events[3]).toStrictEqual({ type: "delta", toolCallDeltas: [{ index: 1, argumentsDelta: 'CET"]' }] });
    expect(events[4]).toStrictEqual({ type: "delta", toolCallDeltas: [{ index: 0, argumentsDelta: 'is"}' }] });
    expect(events[5]).toStrictEqual({ type: "finish", finishReason: "tool_calls" });

    // Consumer-side assembly (the adapter passes fragments through raw):
    // group by index, keep id/name from the first fragment, concat arguments.
    const assembled = new Map<number, { id?: string; functionName?: string; arguments: string }>();
    for (const event of events) {
      if (event.type !== "delta" || !event.toolCallDeltas) continue;
      for (const d of event.toolCallDeltas) {
        const acc = assembled.get(d.index) ?? { arguments: "" };
        if (d.id !== undefined) acc.id = d.id;
        if (d.functionName !== undefined) acc.functionName = d.functionName;
        acc.arguments += d.argumentsDelta ?? "";
        assembled.set(d.index, acc);
      }
    }
    expect(assembled.get(0)).toStrictEqual({ id: "call_a", functionName: "get_weather", arguments: '{"city":"Paris"}' });
    expect(assembled.get(1)).toStrictEqual({ id: "call_b", functionName: "get_time", arguments: '["CET"]' });
  });

  it("surfaces a mid-stream per-choice error as an error event and stops", async () => {
    const { adapter, calls } = adapterFor([
      {
        kind: "response",
        response: sseBody([
          sse({ choices: [{ delta: { content: "partial" } }] }),
          sse({ choices: [{ delta: {}, error: { message: "content policy violation" } }] }),
          sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          DONE,
        ]),
      },
    ]);
    const events = await collect(adapter.stream(params));

    expect(events).toStrictEqual([
      { type: "delta", content: "partial" },
      { type: "error", message: "content policy violation" },
    ]);
    expect(calls.length).toBe(1); // mid-stream failures are never retried
  });
});

// ─── retry policy ───────────────────────────────────────────────────────────

describe("ProviderAdapter retry policy", () => {
  it("does not retry a 4xx and surfaces status + parsed message (chat)", async () => {
    const { adapter, calls } = adapterFor([
      { kind: "response", response: jsonResponse({ error: { message: "Incorrect API key provided" } }, 401) },
    ]);
    let caught: unknown;
    try {
      await adapter.chat(params);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).status).toBe(401);
    expect((caught as UpstreamError).message).toBe("Incorrect API key provided");
    expect(calls.length).toBe(1);
  });

  it("does not retry a 4xx on stream either", async () => {
    const { adapter, calls } = adapterFor([
      { kind: "response", response: jsonResponse({ error: { message: "nope" } }, 400) },
    ]);
    const gen = adapter.stream(params);
    let caught: unknown;
    try {
      await gen.next();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).status).toBe(400);
    expect(calls.length).toBe(1);
  });

  it("retries a 5xx then succeeds (chat)", async () => {
    const { adapter, calls } = adapterFor([
      { kind: "response", response: jsonResponse({ error: { message: "upstream overloaded" } }, 500) },
      { kind: "response", response: jsonResponse(happyChatResponse) },
    ]);
    const result = await adapter.chat(params);
    expect(result.content).toBe("Let me check the weather.");
    expect(calls.length).toBe(2);
  });

  it("retries a network failure then succeeds (chat)", async () => {
    const { adapter, calls } = adapterFor([
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "response", response: jsonResponse(happyChatResponse) },
    ]);
    const result = await adapter.chat(params);
    expect(result.content).toBe("Let me check the weather.");
    expect(calls.length).toBe(2);
  });

  it("retries stream failures that happen before any event was yielded", async () => {
    const { adapter, calls } = adapterFor([
      { kind: "response", response: jsonResponse({ error: { message: "boom" } }, 503) },
      { kind: "throw", error: new TypeError("fetch failed") },
      {
        kind: "response",
        response: sseBody([
          sse({ choices: [{ delta: { content: "ok" } }] }),
          sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          DONE,
        ]),
      },
    ]);
    const events = await collect(adapter.stream(params));

    expect(events).toStrictEqual([
      { type: "delta", content: "ok" },
      { type: "finish", finishReason: "stop" },
    ]);
    expect(calls.length).toBe(3); // 5xx + network + success: 2 retries used
  });

  it("does not retry a stream failure after events were yielded", async () => {
    const { adapter, calls } = adapterFor([
      {
        kind: "response",
        response: sseBody([sse({ choices: [{ delta: { content: "Hel" } }] })], new TypeError("connection reset mid-stream")),
      },
    ]);
    const gen = adapter.stream(params);
    const first = await gen.next();
    expect(first.value).toStrictEqual({ type: "delta", content: "Hel" });
    await expect(gen.next()).rejects.toThrow("connection reset mid-stream");
    expect(calls.length).toBe(1);
  });

  it("retries a timeout then succeeds (timeouts are retryable network errors)", async () => {
    const { adapter, calls } = adapterFor(
      [
        { kind: "hang" },
        { kind: "response", response: jsonResponse(happyChatResponse) },
      ],
      30,
    );
    const result = await adapter.chat(params);
    expect(result.content).toBe("Let me check the weather.");
    expect(calls.length).toBe(2);
    expect((calls[0].init.signal as AbortSignal).aborted).toBe(true);
  });

  it("aborts every attempt on timeout and surfaces the abort after retries", async () => {
    const { adapter, calls } = adapterFor(
      [{ kind: "hang" }, { kind: "hang" }, { kind: "hang" }],
      30,
    );
    let caught: unknown;
    try {
      await adapter.chat(params);
    } catch (e) {
      caught = e;
    }
    expect(calls.length).toBe(3);
    expect(calls.every((c) => (c.init.signal as AbortSignal).aborted)).toBe(true);
    expect((caught as Error).name).toBe("AbortError");
  });
});

// ─── models ─────────────────────────────────────────────────────────────────

describe("ProviderAdapter.models", () => {
  it("passes the parsed JSON through from GET /models", async () => {
    const list = { object: "list", data: [{ id: "glm-5.3-max" }, { id: "other" }] };
    const { adapter, calls } = adapterFor([{ kind: "response", response: jsonResponse(list) }]);
    const result = await adapter.models();

    expect(result).toStrictEqual(list);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://upstream.example/v1/models");
    expect(calls[0].init.method).toBe("GET");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
  });
});
