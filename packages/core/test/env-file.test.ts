// Shared .env parser + host helper tests (packages/core/src/env-file.ts) —
// the ONE copy the proxy config, the CLI and the live smoke tests all use.

import { describe, expect, it } from "vitest";
import { hostOf, parseEnvFile } from "../src/index.js";

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines, skipping blanks, comments, and malformed lines", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "",
        "UPSTREAM_BASE_URL=https://example.com/v1",
        "  SPACED = value with spaces  ",
        "NO_EQUALS_LINE",
        "=NO_KEY",
        "last=one",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      UPSTREAM_BASE_URL: "https://example.com/v1",
      SPACED: "value with spaces",
      last: "one",
    });
  });

  it("strips one layer of matching surrounding quotes (single or double)", () => {
    const parsed = parseEnvFile(
      ['DOUBLE="quoted value"', "SINGLE='quoted value'", "EMPTY=\"\"", 'MIXED="no\''].join("\n"),
    );
    expect(parsed).toEqual({
      DOUBLE: "quoted value",
      SINGLE: "quoted value",
      EMPTY: "",
      MIXED: "\"no'", // mismatched quotes are NOT stripped
    });
  });

  it("an empty string parses to an empty map", () => {
    expect(parseEnvFile("")).toEqual({});
  });
});

describe("hostOf", () => {
  it("returns the URL's host (never the path, scheme, or credentials)", () => {
    expect(hostOf("https://api.example.com/v1")).toBe("api.example.com");
    expect(hostOf("http://localhost:8787/v1/")).toBe("localhost:8787");
  });

  it("returns the shared placeholder for unparseable input", () => {
    expect(hostOf("not a url")).toBe("(unparseable host)");
    expect(hostOf("")).toBe("(unparseable host)");
  });
});
