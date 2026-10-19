// EngineSpillStore — durable spill records for ENGINE-initiated fits.
//
// The dispatch funnel strategy-fits every over-cap message list before it
// leaves the engine (worker slices, the synthesizer prompt, degraded direct
// calls). Whatever such a fit removed must not vanish: the reversibility
// constraint ("every removed message lands in a spill record restorable by
// pointer") binds the ENGINE's fits just as it binds the strategies' own —
// and a diskless strategy (TruncationStrategy, a supported `STRATEGY`
// configuration) leaves the engine as the only place that record can come
// from. Under the default HierarchyStrategy the engine's record duplicates
// what the strategy itself already persisted; that is deliberate — the
// record is written uniformly, whatever the configured strategy does.
//
// One content-addressed JSON file per fit: `${dataDir}/engine-spills/<key>.json`
// where key = sha256(JSON.stringify({ call, messages })) over the fit's INPUT
// (the list the spill indices refer to). The record holds the full input, the
// full spill (each entry already carries the complete original message), and
// a per-entry pointer naming this file — `restore(pointer)` reads it back and
// verifies the hash. Files are written once (open-exclusive "wx"); a same-key
// refit resolves benignly (append-only, first record wins).
//
// Write failures PROPAGATE (unlike the best-effort distillate cache): a spill
// record is a reversibility guarantee, not an accelerator — silently dropping
// it would silently discard messages, the exact thing the constraint forbids.
// The failing dispatch degrades like any model-call failure; that is the same
// stance HierarchyStrategy takes on its own spill files.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SpillRestoreError } from "./strategies/hierarchy.js";
import type { ChatMessage, ToolCall } from "./types.js";
import type { SpilledMessage } from "./strategy.js";

/** Spill pointer shape: 64 lowercase hex chars + `.json` (same as hierarchy).
 *  Exported as THE one pointer-shape source — hierarchy imports it. */
export const POINTER_RE = /^[0-9a-f]{64}\.json$/;

/** One recorded removal: the seam's SpilledMessage plus this record's pointer. */
export interface EngineSpillEntry extends SpilledMessage {
  /** Name of this record's file — `restore(pointer)` reads it back. */
  pointer: string;
}

/** One engine-initiated fit's durable record: what was fitted, what left. */
export interface EngineSpillRecord {
  /** The sub-call kind whose dispatch triggered the fit. */
  call: string;
  /** The fit's INPUT message list — the indices in `spill` refer to it. */
  input: ChatMessage[];
  /** Everything the fit removed, each with the full original message. */
  spill: EngineSpillEntry[];
}

/** True when the value is a structurally valid ChatMessage. */
function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (
    m.role !== "system" &&
    m.role !== "user" &&
    m.role !== "assistant" &&
    m.role !== "tool"
  ) {
    return false;
  }
  if (typeof m.content !== "string") return false;
  if (m.name !== undefined && typeof m.name !== "string") return false;
  if (m.tool_call_id !== undefined && typeof m.tool_call_id !== "string") return false;
  if (m.tool_calls !== undefined) {
    if (!Array.isArray(m.tool_calls)) return false;
    for (const call of m.tool_calls) {
      if (typeof call !== "object" || call === null) return false;
      const c = call as Record<string, unknown>;
      const fn = c.function;
      if (typeof c.id !== "string" || c.type !== "function") return false;
      if (typeof fn !== "object" || fn === null) return false;
      const f = fn as Record<string, unknown>;
      if (typeof f.name !== "string" || typeof f.arguments !== "string") return false;
    }
  }
  return true;
}

/** Corrupt record content → typed error; a never-returning declaration, so
 * the guards below narrow properly. */
function recordCorrupt(pointer: string, why: string): never {
  throw new SpillRestoreError(`corrupt spill record: ${pointer} (${why})`);
}

/** Parse and validate a record file; anything else is corruption. */
function parseRecord(parsed: unknown, pointer: string): EngineSpillRecord {
  if (typeof parsed !== "object" || parsed === null) recordCorrupt(pointer, "not an object");
  const { call, input, spill } = parsed as Record<string, unknown>;
  if (typeof call !== "string" || call.length === 0) recordCorrupt(pointer, "bad call");
  if (!Array.isArray(input) || !input.every(isChatMessage)) {
    recordCorrupt(pointer, "bad input message list");
  }
  if (!Array.isArray(spill)) recordCorrupt(pointer, "spill is not an array");
  const entries: EngineSpillEntry[] = [];
  for (const entry of spill) {
    if (typeof entry !== "object" || entry === null) recordCorrupt(pointer, "bad spill entry");
    const e = entry as Record<string, unknown>;
    if (typeof e.index !== "number" || !Number.isInteger(e.index) || e.index < 0) {
      recordCorrupt(pointer, "bad spill index");
    }
    if (typeof e.reason !== "string") recordCorrupt(pointer, "bad spill reason");
    if (e.pointer !== pointer) recordCorrupt(pointer, "entry pointer mismatch");
    if (!isChatMessage(e.message)) recordCorrupt(pointer, "bad spilled message");
    entries.push({
      index: e.index,
      message: e.message,
      reason: e.reason,
      pointer: e.pointer,
    });
  }
  return { call, input, spill: entries };
}

export class EngineSpillStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "engine-spills");
  }

  /** Content-addressed key over the fit's identity (call) and input list. */
  keyFor(call: string, messages: ChatMessage[]): string {
    return createHash("sha256")
      .update(JSON.stringify({ call, messages }), "utf8")
      .digest("hex");
  }

  /**
   * Persist one engine-initiated fit's spill. Nothing removed → no record
   * (null). The file is written once (open-exclusive); a same-key refit is a
   * benign no-op (append-only, first record wins). IO failures propagate —
   * see the module header for why this is deliberately NOT best-effort.
   */
  async record(
    call: string,
    messages: ChatMessage[],
    spill: SpilledMessage[],
  ): Promise<EngineSpillRecord | null> {
    if (spill.length === 0) return null;
    const key = this.keyFor(call, messages);
    const pointer = `${key}.json`;
    const record: EngineSpillRecord = {
      call,
      input: messages,
      spill: spill.map((entry) => ({ ...entry, pointer })),
    };
    await mkdir(this.dir, { recursive: true });
    try {
      await writeFile(join(this.dir, pointer), `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return record; // append-only
      throw e;
    }
    return record;
  }

  /**
   * Read a record back by pointer. The pointer's shape is validated first
   * (which also blocks path traversal), the content is parsed structurally,
   * and the record's own { call, input } pair must hash back to the pointer —
   * a record that does not verify is corruption, never garbage in.
   */
  async restore(pointer: string): Promise<EngineSpillRecord> {
    if (!POINTER_RE.test(pointer)) {
      throw new SpillRestoreError(`unknown spill pointer: ${JSON.stringify(pointer)}`);
    }
    let raw: string;
    try {
      raw = await readFile(join(this.dir, pointer), "utf8");
    } catch {
      throw new SpillRestoreError(`unknown spill pointer: ${pointer} (no spill record)`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SpillRestoreError(`corrupt spill record: ${pointer} (invalid JSON)`);
    }
    const record = parseRecord(parsed, pointer);
    if (this.keyFor(record.call, record.input) !== pointer.slice(0, -".json".length)) {
      throw new SpillRestoreError(
        `corrupt spill record: ${pointer} (content does not hash to its pointer)`,
      );
    }
    return record;
  }
}
