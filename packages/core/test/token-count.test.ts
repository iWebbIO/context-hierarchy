import { describe, expect, it } from "vitest";
import { countTokens } from "../src/index.js";

// Exact cl100k_base counts, measured with the real encoding:
//   "" -> 0, "hello world" -> 2, "The quick brown fox..." -> 10,
//   '{"city":"Paris"}' -> 5, "You are a helpful assistant." -> 6
describe("countTokens (cl100k_base)", () => {
  it("returns exact counts for fixed strings", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("hello world")).toBe(2);
    expect(countTokens("The quick brown fox jumps over the lazy dog.")).toBe(10);
    expect(countTokens('{"city":"Paris"}')).toBe(5);
    expect(countTokens("You are a helpful assistant.")).toBe(6);
  });

  it("is deterministic across repeated calls", () => {
    const text = "determinism check: hello world";
    const first = countTokens(text);
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) {
      expect(countTokens(text)).toBe(first);
    }
  });

  it("grows with repeated content", () => {
    expect(countTokens("hello world")).toBe(2);
    expect(countTokens("hello world hello world")).toBe(4);
  });
});
