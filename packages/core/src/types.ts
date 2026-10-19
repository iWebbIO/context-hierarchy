// Minimal hand-written OpenAI chat-completions wire types (no SDK dependency).
// Request-side only in v1; response/stream shapes land with the ProviderAdapter.

/** Chat role on the OpenAI wire format. */
export type Role = "system" | "user" | "assistant" | "tool";

/** A single function call requested by or made against the model. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * One message in a chat-completions request.
 * `content` is a plain string for v1 — multimodal parts are out of scope.
 */
export interface ChatMessage {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** Parameters for a (non-)streaming chat-completions call. */
export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
}
