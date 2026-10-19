// Telemetry — append-only JSONL record of what the proxy actually did.
//
// Two event kinds share one file (`${DATA_DIR}/telemetry.jsonl`):
//   http    — one per HTTP request (path, stream?, status, latency)
//   subcall — one per completed model call, accepting the engine's
//             `SubCallEvent` verbatim (ts is stamped here; the engine's
//             events carry no timestamp).
//
// Telemetry is strictly best-effort (task-6 brief R1): no method ever throws
// into request handling — every failure is swallowed with a single console
// warning. `entries()` reads the whole file back (for tests and inspection).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SubCallEvent } from "@context-hierarchy/core";

/** One HTTP request record (`logHttp` argument). */
export interface HttpTelemetryEvent {
  /** ISO-8601 timestamp; supplied by the caller (the server response hook). */
  ts: string;
  /** Route path, e.g. `/v1/chat/completions`. */
  path: string;
  /** Whether the request was served as an SSE stream. */
  stream: boolean;
  /** Response status code. */
  status: number;
  /** Request duration in milliseconds. */
  latencyMs: number;
}

/** A sub-call record (`logSubCall` argument): the engine's SubCallEvent,
 *  plus an optional pre-stamped `ts`. */
export type SubCallTelemetryEvent = SubCallEvent & { ts?: string };

/** Discriminator written on every telemetry line. */
type Kind = "http" | "subcall";

export class Telemetry {
  private ensuredDir = false;

  constructor(private readonly filePath: string) {}

  /** Best-effort append; never throws (warns once per failure). */
  private write(line: Record<string, unknown>): void {
    try {
      if (!this.ensuredDir) {
        mkdirSync(dirname(this.filePath), { recursive: true });
        this.ensuredDir = true;
      }
      appendFileSync(this.filePath, `${JSON.stringify(line)}\n`, "utf8");
    } catch (e) {
      console.warn(
        `[telemetry] failed to append to ${this.filePath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Record one HTTP request. */
  logHttp(event: HttpTelemetryEvent): void {
    this.write({ kind: "http" as Kind, ...event });
  }

  /** Record one completed model call (accepts the engine's `SubCallEvent`). */
  logSubCall(event: SubCallTelemetryEvent): void {
    const { ts, ...rest } = event;
    this.write({ kind: "subcall" as Kind, ts: ts ?? new Date().toISOString(), ...rest });
  }

  /** Read every line back as parsed JSON; corrupt or missing files yield
   *  fewer (or zero) entries, never a throw. */
  entries(): unknown[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return []; // missing or unreadable file → nothing recorded
    }
    const out: unknown[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A corrupt line loses only itself; keep reading the rest.
      }
    }
    return out;
  }
}
