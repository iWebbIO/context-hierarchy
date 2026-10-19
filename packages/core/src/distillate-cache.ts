// DistillateCache — content-addressed persistence for fleet results.
//
// A "distillate" is what one full fleet run produced for one exact request:
// the per-worker digests plus the synthesizer's final result. The cache lets
// a repeated identical request replay that result with ZERO model calls.
//
// Entries are JSON files under `${dataDir}/cache/<key>.json`, written ONCE
// (open-exclusive "wx"); an existing file is never rewritten — append-only,
// like the rest of the persistence in this repo. A missing or corrupt file
// reads as a miss (null); the cache is best-effort and NEVER throws — not on
// read, and not on write: a failed put must never corrupt the request it was
// trying to accelerate (turn an already-delivered answer into an error, or a
// successful fleet run into a degraded re-dispatch).

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, Usage } from "./types.js";

/** The synthesizer's recorded final result. */
export interface DistillateFinal {
  content: string;
  finishReason: string;
  usage?: Usage;
}

/** One fleet run's cached output: worker digests + the final result. */
export interface Distillate {
  digests: string[];
  final: DistillateFinal | null;
}

/** True when the value is a usable `usage` object. */
function isUsage(value: unknown): value is Usage {
  if (typeof value !== "object" || value === null) return false;
  const { promptTokens, completionTokens } = value as {
    promptTokens?: unknown;
    completionTokens?: unknown;
  };
  return (
    typeof promptTokens === "number" &&
    Number.isFinite(promptTokens) &&
    typeof completionTokens === "number" &&
    Number.isFinite(completionTokens)
  );
}

export class DistillateCache {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "cache");
  }

  /**
   * Content-addressed key: sha256 hex of `JSON.stringify({ messages,
   * capTokens, model })`.
   *
   * Documented limitation: the key covers the EXACT request — retries of the
   * same request replay the same distillate, and so does any byte-identical
   * repeat. There is no incremental cross-turn reuse here: a conversation
   * with one new message is a different key and re-fleets from scratch.
   * Incremental reuse comes from the strategies' own content addressing
   * (the hierarchy spill store), not from this cache.
   */
  keyFor(messages: ChatMessage[], capTokens: number, model: string): string {
    return createHash("sha256")
      .update(JSON.stringify({ messages, capTokens, model }), "utf8")
      .digest("hex");
  }

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  /** Read a distillate; null when missing or corrupt (never throws). */
  async get(key: string): Promise<Distillate | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(key), "utf8");
    } catch {
      return null; // missing (or unreadable) file → miss
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return null;
      const candidate = parsed as { digests?: unknown; final?: unknown };
      if (!Array.isArray(candidate.digests)) return null;
      if (!candidate.digests.every((d): d is string => typeof d === "string")) return null;
      if (candidate.final === null) {
        return { digests: candidate.digests, final: null };
      }
      if (typeof candidate.final !== "object" || candidate.final === null) return null;
      const final = candidate.final as {
        content?: unknown;
        finishReason?: unknown;
        usage?: unknown;
      };
      if (typeof final.content !== "string" || typeof final.finishReason !== "string") {
        return null;
      }
      const restored: DistillateFinal = { content: final.content, finishReason: final.finishReason };
      if (isUsage(final.usage)) restored.usage = final.usage;
      return { digests: candidate.digests, final: restored };
    } catch {
      return null; // corrupt JSON → miss, never a throw
    }
  }

  /**
   * Persist a distillate, best-effort. The file is created with
   * open-exclusive semantics: if it already exists the write is skipped —
   * files are written once and never rewritten (append-only). A same-key
   * race resolves benignly (both writers hold the same content). ANY other
   * failure is swallowed: the cache is an accelerator, and a persistence
   * failure must never change the outcome of the request that produced the
   * distillate — the caller already holds the fleet result either way.
   */
  async put(key: string, distillate: Distillate): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.path(key), JSON.stringify(distillate, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return; // written once, never rewritten
      // Best-effort by contract: swallow, never throw over a cache write.
    }
  }
}
