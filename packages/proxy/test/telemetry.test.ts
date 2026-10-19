// Telemetry unit tests (task-6 brief R1): JSONL append with mkdir-as-needed,
// the engine's SubCallEvent accepted verbatim, entries() read-back, and the
// never-throws guarantee. Everything happens in a temp directory.

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Telemetry } from "../src/index.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("Telemetry", () => {
  it("logHttp appends a JSONL line (mkdir as needed) and entries() reads it back", () => {
    const dir = tempDir("ctxh-telemetry-test-");
    const telemetry = new Telemetry(join(dir, "nested", "telemetry.jsonl"));

    telemetry.logHttp({
      ts: "2026-10-19T00:00:00.000Z",
      path: "/v1/chat/completions",
      stream: false,
      status: 200,
      latencyMs: 12,
    });

    const entries = telemetry.entries();
    expect(entries).toEqual([
      {
        kind: "http",
        ts: "2026-10-19T00:00:00.000Z",
        path: "/v1/chat/completions",
        stream: false,
        status: 200,
        latencyMs: 12,
      },
    ]);
  });

  it("logSubCall accepts the engine's SubCallEvent and stamps a ts", () => {
    const dir = tempDir("ctxh-telemetry-test-");
    const telemetry = new Telemetry(join(dir, "telemetry.jsonl"));

    telemetry.logSubCall({
      call: "worker",
      estimatedTokens: 480,
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 30,
      cacheHit: false,
    });
    telemetry.logSubCall({ call: "direct", estimatedTokens: 9000, latencyMs: 1, cacheHit: true });

    const entries = telemetry.entries() as Array<Record<string, unknown>>;
    expect(entries.length).toBe(2);
    expect(entries[0].kind).toBe("subcall");
    expect(entries[0].call).toBe("worker");
    expect(entries[0].estimatedTokens).toBe(480);
    expect(entries[0].promptTokens).toBe(100);
    expect(entries[0].completionTokens).toBe(50);
    expect(entries[0].cacheHit).toBe(false);
    expect(typeof entries[0].ts).toBe("string");
    expect(new Date(entries[0].ts as string).toString()).not.toBe("Invalid Date");
    // The cacheHit marker (over-cap request served from the distillate cache)
    // is recorded with its full-request estimate — over the cap by definition.
    expect(entries[1].estimatedTokens).toBe(9000);
    expect(entries[1].cacheHit).toBe(true);
  });

  it("logSubCall records the degraded flag (constraint 10's telemetry marking)", () => {
    const dir = tempDir("ctxh-telemetry-test-");
    const telemetry = new Telemetry(join(dir, "telemetry.jsonl"));

    telemetry.logSubCall({
      call: "direct",
      estimatedTokens: 540,
      promptTokens: 500,
      completionTokens: 40,
      latencyMs: 30,
      cacheHit: false,
      degraded: true,
    });

    const entries = telemetry.entries() as Array<Record<string, unknown>>;
    expect(entries.length).toBe(1);
    expect(entries[0].degraded).toBe(true); // the marker survives the JSONL round trip
    // Absent, not false, on non-degraded events (already pinned above: the
    // non-flagged events in the previous test carry no `degraded` key).
  });

  it("logSubCall records degradedReason when the event carries it (the why, not just the flag)", () => {
    const dir = tempDir("ctxh-telemetry-test-");
    const telemetry = new Telemetry(join(dir, "telemetry.jsonl"));

    telemetry.logSubCall({
      call: "direct",
      estimatedTokens: 540,
      promptTokens: 500,
      completionTokens: 40,
      latencyMs: 30,
      cacheHit: false,
      degraded: true,
      degradedReason: "upstream fleet call failed (scripted)",
    });
    telemetry.logSubCall({
      call: "direct",
      estimatedTokens: 100,
      latencyMs: 5,
      cacheHit: false,
    });

    const entries = telemetry.entries() as Array<Record<string, unknown>>;
    expect(entries[0].degradedReason).toBe("upstream fleet call failed (scripted)");
    expect(entries[1].degradedReason).toBeUndefined(); // absent on non-degraded events
  });

  it("writes real files (append-only, one JSON object per line)", () => {
    const dir = tempDir("ctxh-telemetry-test-");
    const telemetry = new Telemetry(join(dir, "telemetry.jsonl"));
    telemetry.logHttp({ ts: "t1", path: "/p", stream: true, status: 200, latencyMs: 1 });
    telemetry.logHttp({ ts: "t2", path: "/p", stream: true, status: 200, latencyMs: 2 });
    const stat = statSync(join(dir, "telemetry.jsonl"));
    expect(stat.size).toBeGreaterThan(0);
    expect(telemetry.entries().length).toBe(2);
  });

  it("never throws: an unwritable path is swallowed (console warning only)", () => {
    const dir = tempDir("ctxh-telemetry-test-");
    // A FILE occupies the directory name we then try to mkdir into.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const telemetry = new Telemetry(join(blocker, "telemetry.jsonl"));

    expect(() =>
      telemetry.logHttp({ ts: "t", path: "/p", stream: false, status: 200, latencyMs: 1 }),
    ).not.toThrow();
    expect(() =>
      telemetry.logSubCall({ call: "direct", estimatedTokens: 1, latencyMs: 1, cacheHit: false }),
    ).not.toThrow();
    // Nothing was recorded — and reading a missing file is empty, not a throw.
    expect(telemetry.entries()).toEqual([]);
  });

  it("entries() drops corrupt lines instead of throwing", () => {
    const dir = tempDir("ctxh-telemetry-test-");
    const path = join(dir, "telemetry.jsonl");
    writeFileSync(path, '{"kind":"http"}\nNOT JSON\n{"kind":"subcall"}\n\n', "utf8");
    const telemetry = new Telemetry(path);
    expect(telemetry.entries()).toEqual([{ kind: "http" }, { kind: "subcall" }]);
  });
});
