# Task 2 — ProviderAdapter (SSE-faithful, bounded retries)

## Context

Branch `feat/m1-core-proxy`, tree clean. Task 1 landed `types.ts` (ChatMessage, ChatParams, ToolCall) and the accountant. You add the response/stream wire types and the single funnel through which every model call flows. Faithfulness matters: OpenAI, OpenRouter, and Ollama all speak this dialect with quirks.

## Requirements

R1. Extend `packages/core/src/types.ts` with the result shapes: `Usage` (`promptTokens`, `completionTokens`), `ChatResult` (`content: string`, `toolCalls?: ToolCall[]`, `finishReason: string`, `usage?: Usage`), and a `StreamEvent` union: `{ type: "delta"; content?: string; toolCallDeltas?: { index: number; id?: string; functionName?: string; argumentsDelta?: string }[] } | { type: "finish"; finishReason: string; usage?: Usage } | { type: "error"; message: string }`. Keep the names from the plan contract.

R2. `ProviderAdapter` in `packages/core/src/provider-adapter.ts`, per the plan contract:
- `chat(params)`: POST `${baseUrl}/chat/completions` with `stream: false`, `Authorization: Bearer ${apiKey}`, JSON body carrying `model`, `messages`, `temperature`, `max_tokens`, `tools`, `tool_choice` when present. Map the response to `ChatResult`, aggregating `tool_calls` (present in `message.tool_calls`, `finishReason` from `choices[0].finish_reason`, usage from `usage` when present, mapping `prompt_tokens`/`completion_tokens`).
- `stream(params)`: async generator of `StreamEvent`. POST with `stream: true`; parse SSE from the response body per the OpenAI dialect: lines starting with `:` are comments (ignore them — OpenRouter sends keep-alives); `data: [DONE]` ends the stream; otherwise `data: {json}` is a chunk. Yield `delta` events for `choices[0].delta.content` (when non-empty) and `choices[0].delta.tool_calls` (mapped to `toolCallDeltas`, keyed by `index`). The final chunk with empty `delta` + `finish_reason` yields a `finish` event. Usage: when `stream_options.include_usage` was requested, the usage chunk arrives before `[DONE]` — attach its usage to the `finish` event. Be tolerant of BOTH dialects: OpenAI's usage chunk has an empty `choices` array; OpenRouter's has non-empty `choices` — do not assume either shape (key off `usage` being present). Per-choice `error` objects inside chunks yield an `error` event.
- `models()`: GET `${baseUrl}/models` with the same auth; return the parsed JSON as-is (passthrough, `Promise<unknown>`).
- Constructor takes `AdapterConfig` (`baseUrl` without trailing `/v1` suffix assumptions — normalize: strip trailing `/`), `apiKey`, optional injectable `fetch` (default `globalThis.fetch`), optional `timeoutMs` (default `120_000`) via `AbortController`.
- Retries: on 5xx or network errors only, never on 4xx. Non-stream `chat`: up to 2 retries. `stream`: retry only if the failure happened before any event was yielded. Timeouts count as retryable network errors. 4xx: surface the upstream status and a best-effort parsed error message via a typed `UpstreamError` (with `status?: number`, `message: string`) — do not swallow it.
- A response `model` field differing from the request (OpenRouter fallback renames) is fine — carry it nowhere special; `ChatResult` doesn't need it.

R3. Tests in `packages/core/test/` with an injectable fake `fetch` (scripted `Response` objects, `ReadableStream` bodies for SSE) covering: non-stream happy path with tool_calls aggregation; SSE with content deltas, comments interleaved, `[DONE]`; usage chunk with empty `choices` AND with non-empty `choices`; tool_call delta fragments assembling across chunks by index; mid-stream per-choice `error`; 4xx passthrough with no retry (assert call count = 1); 5xx retried then succeeding (assert call count = 2); network failure retried; timeout aborts. No real network; no `LIVE` paths in this task's tests.

R4. A live smoke file (e.g., `packages/core/test/live-smoke.test.ts`) gated to run only when `process.env.LIVE === "1"`: one `chat()` call against the upstream from `.env` (parse `.env` manually with `fs` — no dotenv dep), asserting a non-empty reply. It must be SKIPPED under plain `npm test` (no network). Note in the test that the key never gets logged.

R5. Export new symbols from `src/index.ts`. `npm test`, `npm run typecheck` green. Commit `task-2: provider adapter (sse-faithful, bounded retries)`, explicit adds.
