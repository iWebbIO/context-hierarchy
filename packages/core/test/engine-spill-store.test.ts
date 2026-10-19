// EngineSpillStore tests (final-review fix wave) — durable, hash-verified
// spill records for engine-initiated strategy fits (global constraint 6,
// engine side). Temp dataDirs only; nothing here touches the network.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineSpillStore } from "../src/index.js";
import type { ChatMessage, SpilledMessage } from "../src/index.js";

const dirs: string[] = [];

function makeStore(): { store: EngineSpillStore; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "ctxh-engine-spill-test-"));
  dirs.push(dataDir);
  return { store: new EngineSpillStore(dataDir), dataDir };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const INPUT: ChatMessage[] = [
  { role: "system", content: "keep me" },
  { role: "user", content: "old dropped question" },
  { role: "assistant", content: "old answer" },
  { role: "user", content: "the final question" },
];

const SPILL: SpilledMessage[] = [
  { index: 1, message: INPUT[1], reason: "dropped-oldest" },
  { index: 2, message: INPUT[2], reason: "dropped-oldest" },
];

describe("EngineSpillStore.record", () => {
  it("returns null (and writes nothing) when the fit removed nothing", async () => {
    const { store, dataDir } = makeStore();
    await expect(store.record("worker", INPUT, [])).resolves.toBeNull();
    expect(existsSync(join(dataDir, "engine-spills"))).toBe(false);
  });

  it("persists a content-addressed record carrying the full input, spill, and per-entry pointer", async () => {
    const { store, dataDir } = makeStore();
    const record = await store.record("worker", INPUT, SPILL);
    expect(record).not.toBeNull();

    const pointer = record!.spill[0].pointer;
    expect(pointer).toMatch(/^[0-9a-f]{64}\.json$/);
    const path = join(dataDir, "engine-spills", pointer);
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk).toEqual({
      call: "worker",
      input: INPUT,
      spill: [
        { index: 1, message: INPUT[1], reason: "dropped-oldest", pointer },
        { index: 2, message: INPUT[2], reason: "dropped-oldest", pointer },
      ],
    });
  });

  it("keys records by call kind AND input list", async () => {
    const { store } = makeStore();
    const a = await store.record("worker", INPUT, SPILL);
    const b = await store.record("synthesizer", INPUT, SPILL);
    expect(a!.spill[0].pointer).not.toBe(b!.spill[0].pointer);
  });

  it("is append-only: a same-key re-record never rewrites the file", async () => {
    const { store } = makeStore();
    const first = await store.record("worker", INPUT, SPILL);
    const second = await store.record("worker", INPUT, [
      { index: 1, message: INPUT[1], reason: "some-other-reason" },
    ]);
    // Same key → same pointer, benign no-op; the first record survives.
    expect(second!.spill[0].pointer).toBe(first!.spill[0].pointer);
    const restored = await store.restore(first!.spill[0].pointer);
    expect(restored.spill).toEqual(first!.spill);
  });

  it("propagates real IO failures (a spill record is a guarantee, not best-effort)", async () => {
    const { store, dataDir } = makeStore();
    // A FILE where the directory needs to be → mkdir fails ENOTDIR/EEXIST.
    writeFileSync(join(dataDir, "engine-spills"), "not a directory", "utf8");
    await expect(store.record("worker", INPUT, SPILL)).rejects.toThrow();
  });
});

describe("EngineSpillStore.restore", () => {
  it("round-trips a record by pointer", async () => {
    const { store } = makeStore();
    const record = await store.record("degraded", INPUT, SPILL);
    const restored = await store.restore(record!.spill[0].pointer);
    expect(restored).toEqual(record);
    // The spilled message is the FULL original, untouched.
    expect(restored.spill[0].message).toEqual(INPUT[1]);
  });

  it("rejects a malformed pointer (shape check blocks path traversal too)", async () => {
    const { store } = makeStore();
    await expect(store.restore("../secrets.json")).rejects.toThrow(
      "unknown spill pointer",
    );
    await expect(store.restore("deadbeef.json")).rejects.toThrow("unknown spill pointer");
  });

  it("rejects an unknown pointer (no such record)", async () => {
    const { store } = makeStore();
    await expect(store.restore(`${"0".repeat(64)}.json`)).rejects.toThrow(
      "no spill record",
    );
  });

  it("rejects corrupt records: invalid JSON, bad structure, hash mismatch", async () => {
    const { store, dataDir } = makeStore();
    const record = await store.record("worker", INPUT, SPILL);
    const pointer = record!.spill[0].pointer;
    const path = join(dataDir, "engine-spills", pointer);

    // Invalid JSON.
    writeFileSync(path, "{not json", "utf8");
    await expect(store.restore(pointer)).rejects.toThrow("invalid JSON");

    // Structurally bad: spill entries without messages.
    writeFileSync(path, JSON.stringify({ call: "worker", input: [], spill: [{ index: 1 }] }), "utf8");
    await expect(store.restore(pointer)).rejects.toThrow("corrupt spill record");

    // Hash mismatch: content that does not hash to its pointer.
    const forged = {
      call: "worker",
      input: [{ role: "user", content: "forged" }],
      spill: [{ index: 0, message: { role: "user", content: "forged" }, reason: "x", pointer }],
    };
    writeFileSync(path, JSON.stringify(forged), "utf8");
    await expect(store.restore(pointer)).rejects.toThrow(
      "content does not hash to its pointer",
    );
  });
});

describe("EngineSpillStore keyFor", () => {
  it("is deterministic and content-addressed over { call, messages }", async () => {
    const { store } = makeStore();
    const a = store.keyFor("worker", INPUT);
    expect(store.keyFor("worker", INPUT)).toBe(a);
    expect(store.keyFor("worker", [...INPUT, { role: "user", content: "more" }])).not.toBe(a);
    expect(store.keyFor("planner", INPUT)).not.toBe(a);
  });

  it("keys are written under ${dataDir}/engine-spills/<key>.json", async () => {
    const { store, dataDir } = makeStore();
    const record = await store.record("worker", INPUT, SPILL);
    const key = store.keyFor("worker", INPUT);
    expect(existsSync(join(dataDir, "engine-spills", `${key}.json`))).toBe(true);
    mkdirSync(join(dataDir, "engine-spills"), { recursive: true }); // no-op assertion aid
  });
});
