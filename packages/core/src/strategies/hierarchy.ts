// HierarchyStrategy — the DEFAULT strategy: the filesystem tiered memory that
// makes small-context serving survivable (task-4 brief).
//
// fit() pipeline:
//   Stage 1 — rule-based elision (deterministic, zero LLM): tool-role messages
//   older than the LAST 3 message indices become a one-line placeholder
//   `[elided tool result: <first 60 chars>…]`, and runs of 3+ blank lines
//   collapse to a single blank line. If the elided list fits the budget, it is
//   returned immediately — ZERO adapter calls.
//   Stage 2 — exactly ONE capped condense call over the MIDDLE (every
//   non-system message older than the last 4). The condense prompt is the
//   fixed instruction plus the ELIDED middle, hard-fitted to the budget with
//   the internal TruncationStrategy when needed and estimated pre-dispatch
//   (global constraint 1: a condense call is a model call like any other).
//   With an EMPTY middle there is nothing to condense: no adapter call and no
//   digest message — the "digest of nothing" case resolves via the Stage-3
//   hard-fit alone.
//   Stage 3 — compose + hard-fit: [all system messages] + [one digest message
//   wrapped in [condensed history]…[/condensed history]] + [the last 4
//   non-system messages], hard-fitted with the internal truncation strategy so
//   the result NEVER exceeds the budget (the digest counts as a normal
//   message; it gets no special protection).
//
// Spilling: every INPUT message that does not appear verbatim in the final
// result is written once as a content-addressed file under
// `${dataDir}/hierarchy/spills/<sha256>.json` (append-only; existing files are
// never rewritten) and recorded with the reason it left:
//   "elided"    — its Stage-1 reduced form (placeholder / collapsed blanks)
//                 survived; the original is restorable from the spill.
//   "condensed" — it was middle material, replaced by the digest.
//   "dropped" / "middle-cut" — removed or cut by the final hard-fit.
// The digest message itself is never spilled: it is not an input message, and
// every message it stands for is already spilled in full.
//
// Deliberate design decisions (the brief is silent on these):
//   - Under-budget input passes through verbatim (same list reference, empty
//     spill) — consistent with the TruncationStrategy seam contract.
//   - The digest message has role "user": the brief pins only its content.
//   - An adapter error on the condense call propagates; degradation to a
//     truncation-fit call is owned by the engine (global constraint 10).

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { POINTER_RE } from "../engine-spill-store.js";
import type {
  ContextStrategy,
  FitResult,
  SpilledMessage,
  StrategyCtx,
} from "../strategy.js";
import { TruncationStrategy } from "./truncation.js";
import type { ChatMessage, Role, ToolCall } from "../types.js";

/** Condense instruction — embedded VERBATIM in the condense prompt (brief R1). */
const CONDENSE_INSTRUCTION =
  "You compress a conversation history for a model with a very small context window. Preserve VERBATIM: all code blocks, quoted strings, file paths, identifiers, numbers, URLs, and every decision or commitment made. Output plain text only, no preamble, no meta-commentary. Be dense; omit nothing load-bearing.";

/** Digest wrap markers (brief R1, stage 3). */
const DIGEST_OPEN = "[condensed history]";
const DIGEST_CLOSE = "[/condensed history]";

/** Tail size: the last 4 non-system messages pass through verbatim. */
const TAIL_KEEP = 4;
/** tool-role messages within the LAST 3 message indices escape elision. */
const TOOL_RECENT_INDICES = 3;
/** Excerpt length inside the tool-result placeholder, in characters. */
const EXCERPT_CHARS = 60;
/** max_tokens for the single condense call (brief R1). */
const CONDENSE_MAX_TOKENS = 800;

// The spill pointer shape is shared with the engine's spill store — imported
// from engine-spill-store.ts (one source of truth, no second regex).

/** The four spill reasons this strategy records (brief R2). */
type HierarchySpillReason = "elided" | "condensed" | "dropped" | "middle-cut";

/** Raised by `restore` for an unknown or corrupt pointer — never returns garbage. */
export class SpillRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpillRestoreError";
  }
}

/** Bug detector: a violated fitting invariant is thrown, never swallowed. */
function invariant(condition: boolean, message: string): void {
  if (!condition) throw new Error(`hierarchy invariant violated: ${message}`);
}

/** One-line placeholder standing in for an elided tool result (exact form is contract). */
function toolElisionPlaceholder(content: string): string {
  // Newlines are flattened so the placeholder stays one line.
  const excerpt = content.slice(0, EXCERPT_CHARS).replace(/[\r\n]+/g, " ");
  return `[elided tool result: ${excerpt}…]`;
}

/** Collapse runs of 3+ blank lines (4+ consecutive newlines) to a single blank line. */
function collapseBlankLines(content: string): string {
  return content.replace(/(?:\r?\n){4,}/g, "\n\n");
}

/**
 * Fixed-key-order serialization of a message: makes the content hash stable
 * regardless of the key order the message object arrived with.
 */
function canonicalMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.name !== undefined) out.name = m.name;
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
  if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
  return out;
}

/** Content-addressed file name for a spilled message. */
function spillPointerFor(m: ChatMessage): string {
  const json = JSON.stringify(canonicalMessage(m));
  return `${createHash("sha256").update(json, "utf8").digest("hex")}.json`;
}

/** Write the spill file once (async, open-exclusive "wx"): a same-pointer race
 *  resolves benignly (EEXIST = the identical file is already there), and
 *  existing files are never rewritten (append-only). */
async function writeSpillFile(dataDir: string, pointer: string, m: ChatMessage): Promise<void> {
  const spillsDir = join(dataDir, "hierarchy", "spills");
  await mkdir(spillsDir, { recursive: true });
  try {
    await writeFile(
      join(spillsDir, pointer),
      `${JSON.stringify(canonicalMessage(m), null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return; // append-only, first write wins
    throw e;
  }
}

function isRole(v: unknown): v is Role {
  return v === "system" || v === "user" || v === "assistant" || v === "tool";
}

/** Corrupt spill content → typed error; a never-returning declaration, so the
 * guards below narrow properly. */
function spillCorrupt(pointer: string): never {
  throw new SpillRestoreError(`corrupt spill file: ${pointer}`);
}

/** Parse and validate a spilled message; anything else is corruption. */
function parseSpilledMessage(parsed: unknown, pointer: string): ChatMessage {
  if (typeof parsed !== "object" || parsed === null) spillCorrupt(pointer);
  const { role, content, name, tool_call_id, tool_calls } = parsed as Record<
    string,
    unknown
  >;
  if (!isRole(role) || typeof content !== "string") spillCorrupt(pointer);
  const message = { role, content } as ChatMessage;
  if (name !== undefined) {
    if (typeof name !== "string") spillCorrupt(pointer);
    message.name = name;
  }
  if (tool_call_id !== undefined) {
    if (typeof tool_call_id !== "string") spillCorrupt(pointer);
    message.tool_call_id = tool_call_id;
  }
  if (tool_calls !== undefined) {
    if (!Array.isArray(tool_calls)) spillCorrupt(pointer);
    for (const call of tool_calls) {
      if (typeof call !== "object" || call === null) spillCorrupt(pointer);
      const { id, type, function: fn } = call as Record<string, unknown>;
      if (typeof id !== "string" || type !== "function") spillCorrupt(pointer);
      if (typeof fn !== "object" || fn === null) spillCorrupt(pointer);
      const { name: fnName, arguments: fnArgs } = fn as Record<string, unknown>;
      if (typeof fnName !== "string" || typeof fnArgs !== "string") spillCorrupt(pointer);
    }
    message.tool_calls = tool_calls as ToolCall[];
  }
  return message;
}

/**
 * The tiered-memory default: deterministic elision first, exactly one capped
 * LLM condense call over the middle when rules do not suffice, head+tail
 * verbatim, everything removed spilled to content-addressed files restorable
 * by pointer.
 */
export class HierarchyStrategy implements ContextStrategy {
  readonly name = "hierarchy";

  /** Composed for this strategy's own hard-fitting needs (brief R1). */
  private readonly truncation = new TruncationStrategy();

  async fit(
    input: { messages: ChatMessage[]; budgetTokens: number },
    ctx: StrategyCtx,
  ): Promise<FitResult> {
    const { messages, budgetTokens } = input;
    const estimate = (msgs: ChatMessage[]): number =>
      ctx.accountant.estimate(msgs, ctx.model);
    const spillEntry = async (index: number, reason: HierarchySpillReason): Promise<SpilledMessage> => {
      const original = messages[index];
      const pointer = spillPointerFor(original);
      await writeSpillFile(ctx.dataDir, pointer, original);
      return { index, message: original, reason, pointer };
    };

    // Under budget: verbatim pass-through — zero adapter calls, nothing spilled.
    if (estimate(messages) <= budgetTokens) {
      return { messages, spill: [] };
    }

    // ---- Stage 1: rule-based elision (deterministic, zero LLM) ----
    // Tool results older than the last 3 message indices become one-line
    // placeholders; runs of 3+ blank lines collapse. Untouched messages keep
    // their original object reference (identity drives the spill bookkeeping).
    const toolCutoff = messages.length - TOOL_RECENT_INDICES;
    const stage1 = messages.map((m, i): ChatMessage => {
      let msg = m;
      if (m.role === "tool" && i < toolCutoff) {
        msg = { ...m, content: toolElisionPlaceholder(m.content) };
      }
      const collapsed = collapseBlankLines(msg.content);
      return collapsed === msg.content ? msg : { ...msg, content: collapsed };
    });

    if (estimate(stage1) <= budgetTokens) {
      const spill: SpilledMessage[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (stage1[i] !== messages[i]) spill.push(await spillEntry(i, "elided"));
      }
      return { messages: stage1, spill };
    }

    // ---- Stage 2: exactly one capped condense call over the MIDDLE ----
    // Middle = every non-system message older than the tail (last 4).
    const systemIdx: number[] = [];
    const nonSystemIdx: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "system") systemIdx.push(i);
      else nonSystemIdx.push(i);
    }
    const tailIdx = nonSystemIdx.slice(Math.max(0, nonSystemIdx.length - TAIL_KEEP));
    const middleIdx = nonSystemIdx.slice(0, nonSystemIdx.length - tailIdx.length);

    let digest: string | null = null;
    if (middleIdx.length > 0) {
      let prompt: ChatMessage[] = [
        { role: "system", content: CONDENSE_INSTRUCTION },
        ...middleIdx.map((i) => stage1[i]),
      ];
      if (estimate(prompt) > budgetTokens) {
        // The condense call is a model call like any other: its prompt must
        // fit the cap. The internal truncation fit guarantees it does.
        prompt = (await this.truncation.fit({ messages: prompt, budgetTokens }, ctx)).messages;
      }
      invariant(estimate(prompt) <= budgetTokens, "condense prompt exceeds the cap after fit");
      const condensed = await ctx.adapter.chat({
        model: ctx.model,
        messages: prompt,
        max_tokens: CONDENSE_MAX_TOKENS,
      });
      digest = condensed.content;
    }

    // ---- Stage 3: compose + hard-fit ----
    // [all system messages] + [digest message] + [last 4 non-system messages];
    // then never let the composition exceed the budget.
    const composition: ChatMessage[] = systemIdx.map((i) => stage1[i]);
    if (digest !== null) {
      composition.push({
        role: "user",
        content: `${DIGEST_OPEN}\n${digest}\n${DIGEST_CLOSE}`,
      });
    }
    composition.push(...tailIdx.map((i) => stage1[i]));

    let fitted = composition;
    let truncSpill: SpilledMessage[] = [];
    if (estimate(composition) > budgetTokens) {
      const hard = await this.truncation.fit({ messages: composition, budgetTokens }, ctx);
      fitted = hard.messages;
      truncSpill = hard.spill;
    }
    invariant(estimate(fitted) <= budgetTokens, "fitted result exceeds the cap");

    // Map the hard-fit's removals back to input indices. Composition layout:
    // [systems…][digest?][tail…]; the digest is not an input message — it is
    // skipped (the middle's originals are already spilled in full).
    const digestAt = digest !== null ? systemIdx.length : -1;
    const hardFate = new Map<number, HierarchySpillReason>();
    for (const entry of truncSpill) {
      const ci = entry.index;
      let inputIndex: number;
      if (ci < systemIdx.length) {
        inputIndex = systemIdx[ci];
      } else if (ci === digestAt) {
        continue; // the digest message itself
      } else {
        inputIndex = tailIdx[ci - systemIdx.length - (digestAt >= 0 ? 1 : 0)];
      }
      hardFate.set(inputIndex, entry.reason === "middle-cut" ? "middle-cut" : "dropped");
    }

    // Final spill: every input message not verbatim in the fitted result.
    const middleSet = new Set(middleIdx);
    const spill: SpilledMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (stage1[i] === messages[i] && fitted.includes(stage1[i])) {
        continue; // original survived verbatim
      }
      let reason: HierarchySpillReason;
      if (middleSet.has(i)) {
        reason = "condensed";
      } else {
        const fate = hardFate.get(i);
        if (fate !== undefined) {
          reason = fate; // the hard-fit dropped or middle-cut it
        } else if (stage1[i] !== messages[i]) {
          reason = "elided"; // its Stage-1 reduced form survived
        } else {
          // Unreachable while the truncation contract holds (it spills
          // everything it removes); kept as a bug detector.
          throw new Error(
            `hierarchy invariant violated: message ${i} is neither kept nor accounted for`,
          );
        }
      }
      spill.push(await spillEntry(i, reason));
    }
    return { messages: fitted, spill };
  }

  async restore(pointer: string, ctx: StrategyCtx): Promise<ChatMessage> {
    // Shape validation first: this also blocks path-traversal pointers.
    if (!POINTER_RE.test(pointer)) {
      throw new SpillRestoreError(`unknown spill pointer: ${JSON.stringify(pointer)}`);
    }
    const path = join(ctx.dataDir, "hierarchy", "spills", pointer);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new SpillRestoreError(`unknown spill pointer: ${pointer} (no spill file)`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SpillRestoreError(`corrupt spill file: ${pointer} (invalid JSON)`);
    }
    const message = parseSpilledMessage(parsed, pointer);
    if (spillPointerFor(message) !== pointer) {
      throw new SpillRestoreError(
        `corrupt spill file: ${pointer} (content does not hash to its pointer)`,
      );
    }
    return message;
  }
}
