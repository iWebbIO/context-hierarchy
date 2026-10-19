import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DistillateCache } from "../src/index.js";
import type { Distillate, ChatMessage } from "../src/index.js";

// All tests run against throwaway dataDirs under os.tmpdir() — never the
// repo's .ctxh.
const dirs: string[] = [];

function makeCache(): { cache: DistillateCache; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "ctxh-distill-test-"));
  dirs.push(dataDir);
  return { cache: new DistillateCache(dataDir), dataDir };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "you are a test" },
  { role: "user", content: "hello there" },
];

const DISTILLATE: Distillate = {
  digests: ["digest one", "digest two"],
  final: {
    content: "final answer",
    finishReason: "stop",
    usage: { promptTokens: 11, completionTokens: 7 },
  },
};

describe("DistillateCache", () => {
  it("keyFor is the sha256 hex of JSON.stringify({ messages, capTokens, model })", () => {
    const { cache } = makeCache();
    const expected = createHash("sha256")
      .update(JSON.stringify({ messages: MESSAGES, capTokens: 512, model: "m1" }), "utf8")
      .digest("hex");
    const key = cache.keyFor(MESSAGES, 512, "m1");
    expect(key).toBe(expected);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keys differ across messages, capTokens, and model", () => {
    const { cache } = makeCache();
    const base = cache.keyFor(MESSAGES, 512, "m1");
    expect(cache.keyFor(MESSAGES, 513, "m1")).not.toBe(base);
    expect(cache.keyFor(MESSAGES, 512, "m2")).not.toBe(base);
    expect(
      cache.keyFor([...MESSAGES, { role: "user", content: "one more" }], 512, "m1"),
    ).not.toBe(base);
    // Same input twice → same key (content addressing is deterministic).
    expect(cache.keyFor(MESSAGES, 512, "m1")).toBe(base);
  });

  it("get on a missing key returns null", async () => {
    const { cache } = makeCache();
    await expect(cache.get("0".repeat(64))).resolves.toBeNull();
  });

  it("put then get roundtrips the distillate", async () => {
    const { cache } = makeCache();
    const key = cache.keyFor(MESSAGES, 512, "m1");
    await cache.put(key, DISTILLATE);
    await expect(cache.get(key)).resolves.toEqual(DISTILLATE);
  });

  it("roundtrips a distillate whose final is null", async () => {
    const { cache } = makeCache();
    const key = cache.keyFor(MESSAGES, 512, "m1");
    const d: Distillate = { digests: [], final: null };
    await cache.put(key, d);
    await expect(cache.get(key)).resolves.toEqual(d);
  });

  it("persists a content-addressed JSON file under ${dataDir}/cache/<key>.json", async () => {
    const { cache, dataDir } = makeCache();
    const key = cache.keyFor(MESSAGES, 512, "m1");
    await cache.put(key, DISTILLATE);
    const path = join(dataDir, "cache", `${key}.json`);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(DISTILLATE);
  });

  it("is append-only: a second put with different content never rewrites the file", async () => {
    const { cache, dataDir } = makeCache();
    const key = cache.keyFor(MESSAGES, 512, "m1");
    await cache.put(key, DISTILLATE);
    const replacement: Distillate = { digests: ["other"], final: null };
    await cache.put(key, replacement);
    await expect(cache.get(key)).resolves.toEqual(DISTILLATE); // first write wins
    const path = join(dataDir, "cache", `${key}.json`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(DISTILLATE);
  });

  it("a corrupt cache file reads as a miss, never a throw", async () => {
    const { cache, dataDir } = makeCache();
    const key = cache.keyFor(MESSAGES, 512, "m1");
    await cache.put(key, DISTILLATE);
    // Corrupt the file behind the cache's back.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(dataDir, "cache"), { recursive: true });
    writeFileSync(join(dataDir, "cache", `${key}.json`), "{not json", "utf8");
    await expect(cache.get(key)).resolves.toBeNull();
  });

  it("put is best-effort: an IO failure NEVER throws over a successful run", async () => {
    // A file where the cache DIRECTORY belongs → mkdir fails → put swallows.
    // The cache is an accelerator: a write failure must not corrupt the
    // outcome of the request that produced the distillate (the final-review
    // finding this pins — the old put rethrew every non-EEXIST error).
    const { cache, dataDir } = makeCache();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dataDir, "cache"), "not a directory", "utf8");
    const key = cache.keyFor(MESSAGES, 512, "m1");
    await expect(cache.put(key, DISTILLATE)).resolves.toBeUndefined();
    // Nothing was written (the directory could not even be made).
    expect(existsSync(join(dataDir, "cache", `${key}.json`))).toBe(false);
  });
});
