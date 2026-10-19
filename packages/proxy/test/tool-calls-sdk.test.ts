// Deterministic scripted-fake unit test: the tool_calls chunking path
// end-to-end through the REAL proxy — fake adapter → real FleetEngine →
// buildServer SSE — unwrapped by the REAL OpenAI SDK client. The SDK is
// driven through a fake `fetch` backed by fastify.inject, so plain
// `npm test` opens no socket and touches no network.
//
// The SDK's ChatCompletionStream aggregates our re-chunked tool-call deltas
// (index / id / name / arguments fragments) back into the complete wire
// message — the proxy-SSE → SDK-shape round trip this test pins. The raw-SSE
// fragment shapes of the same scenario are already asserted in
// server.test.ts's tool-call deltas test; this file adds the client-side
// unwrap on top.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import OpenAI from "openai";
import type { FastifyInstance } from "fastify";
import { FleetEngine, TokenAccountant, TruncationStrategy } from "@context-hierarchy/core";
import type { ChatParams, ChatResult, ProviderAdapter, StreamEvent } from "@context-hierarchy/core";
import { Telemetry, buildServer, subCallSink } from "../src/index.js";
import type { ProxyConfig } from "../src/index.js";

const MODEL = "proxy-test-model";

/** The scripted upstream stream: tool-call deltas split across three chunks
 *  (id+name first, then argument fragments), a content delta, then finish. */
const TOOL_STREAM: StreamEvent[] = [
  {
    type: "delta",
    toolCallDeltas: [{ index: 0, id: "call_1", functionName: "get_weather", argumentsDelta: "" }],
  },
  { type: "delta", toolCallDeltas: [{ index: 0, argumentsDelta: "{\"ci" }] },
  { type: "delta", toolCallDeltas: [{ index: 0, argumentsDelta: "ty\":\"Berlin\"}" }] },
  { type: "delta", content: "calling the tool" },
  { type: "finish", finishReason: "tool_calls", usage: { promptTokens: 5, completionTokens: 2 } },
];

/** Recording fake adapter: a stream request must be the only call. */
class FakeAdapter {
  readonly calls: ChatParams[] = [];

  async chat(_params: ChatParams): Promise<ChatResult> {
    throw new Error("chat() must not be called for a stream request");
  }

  async *stream(params: ChatParams): AsyncGenerator<StreamEvent> {
    this.calls.push(params);
    for (const event of TOOL_STREAM) yield event;
  }

  async models(): Promise<unknown> {
    return { object: "list", data: [] };
  }
}

interface Harness {
  app: FastifyInstance;
  adapter: FakeAdapter;
  /** Raw SSE body of the last request that went through the fake fetch. */
  lastSse: string;
  close(): Promise<void>;
}

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()?.();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** REAL engine + REAL accountant + REAL strategy + fake adapter, temp dataDir. */
function makeHarness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "ctxh-toolcalls-test-"));
  dirs.push(dataDir);
  const adapter = new FakeAdapter();
  const telemetry = new Telemetry(join(dataDir, "telemetry.jsonl"));
  const engine = new FleetEngine({
    adapter: adapter as unknown as ProviderAdapter,
    accountant: new TokenAccountant({ dataDir }),
    strategy: new TruncationStrategy(),
    capTokens: 600,
    model: MODEL,
    dataDir,
    onSubCall: subCallSink(telemetry),
  });
  const cfg: ProxyConfig = {
    upstreamBaseUrl: "https://fake.example/v1",
    upstreamApiKey: "unused",
    upstreamModel: MODEL,
    capTokens: 600,
    port: 0,
    strategy: "hierarchy",
    concurrency: 3,
    dataDir,
    proxyApiKey: "",
  };
  const app = buildServer({
    adapter: adapter as unknown as ProviderAdapter,
    engine,
    telemetry,
    cfg,
  });
  const close = () => app.close();
  closers.push(close);
  return { app, adapter, lastSse: "", close };
}

/**
 * A `fetch` for the SDK backed by fastify.inject: no socket, no network. The
 * proxy's SSE response body is wrapped in a web ReadableStream so the SDK's
 * SSE parser consumes it exactly as it would a real wire response.
 */
function injectFetch(h: Harness): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(rawUrl).pathname;
    if (typeof init?.body !== "string") {
      throw new Error(`unexpected non-string request body: ${String(init?.body)}`);
    }
    const res = await h.app.inject({
      method: "POST",
      url: pathname,
      headers: { "content-type": "application/json" },
      payload: init.body,
    });
    h.lastSse = res.body;
    const bytes = new TextEncoder().encode(res.body);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return new Response(body, {
      status: res.statusCode,
      headers: { "content-type": String(res.headers["content-type"]) },
    });
  };
}

describe("tool_calls chunking, end-to-end through the real proxy (fake adapter, SDK unwrap)", () => {
  it("the SDK unwraps the proxy's re-chunked tool_calls SSE into the complete wire message", async () => {
    const h = makeHarness();
    const client = new OpenAI({
      baseURL: "http://sdk-inject.test/v1",
      apiKey: "sk-test",
      fetch: injectFetch(h),
    });

    // A small request (under the cap) → the engine streams the fake
    // adapter's tool-call deltas straight through; the proxy re-chunks them.
    const stream = client.chat.completions.stream({
      model: "sdk-unwrapped-model",
      messages: [{ role: "user", content: "What is the weather in Berlin?" }],
      stream: true,
    });
    const completion = await stream.finalChatCompletion();

    // SDK-unwrapped shape: one complete tool call — id and name from the
    // first fragment, arguments concatenated from the delta fragments.
    const message = completion.choices[0].message;
    expect(message.role).toBe("assistant");
    expect(message.content).toBe("calling the tool");
    expect(message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: "{\"city\":\"Berlin\"}" },
      },
    ]);
    expect(completion.choices[0].finish_reason).toBe("tool_calls");
    expect(completion.model).toBe(MODEL);

    // Raw-level sanity from the same response: our SSE terminated with
    // [DONE], and exactly one request went through the proxy's chat route
    // (routed to the proxy's upstream model).
    expect(h.lastSse.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(h.adapter.calls.length).toBe(1);
    expect(h.adapter.calls[0].model).toBe(MODEL);
  });
});
