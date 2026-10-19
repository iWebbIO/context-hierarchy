// M2 Track A — task suite integrity test.
//
// Verifies the generator output WITHOUT trusting it: ground truths are
// re-derived here from the haystacks and the fixture on disk (regex recounts,
// re-executed fixture calls), determinism is proven by a fresh buildSuite()
// call, and contamination is checked with a blocklist over the serialized
// tasks. No network, no clock, no randomness — plain `npm test` safe.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSuite, GROUNDINGS, TASKS } from "../tasks/index.js";
import type { BenchmarkTask } from "../tasks/types.js";
import { formatBytes } from "../tasks/fixture-repo/units.js";
import { titleCase } from "../tasks/fixture-repo/string-utils.js";

const here = dirname(fileURLToPath(import.meta.url));
const tasksDir = join(here, "..", "tasks");
const fixtureDir = join(tasksDir, "fixture-repo");

const byId = new Map(TASKS.map((t) => [t.id, t]));
const task = (id: string): BenchmarkTask => {
  const found = byId.get(id);
  if (!found) throw new Error(`task not found: ${id}`);
  return found;
};
/** The haystack message (messages[1]) — where needles must be grounded. */
const haystackOf = (t: BenchmarkTask): string => {
  const msg = t.messages[1];
  if (!msg) throw new Error(`task ${t.id} has no haystack message`);
  return msg.content;
};
/** Count non-overlapping occurrences of `code` not followed by a digit
 *  (so "KR-71" does not match inside the longer code "KR-7112"). */
function occurrences(haystack: string, code: string): number {
  const re = new RegExp(`${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`, "g");
  return [...haystack.matchAll(re)].length;
}

// ---------------------------------------------------------------------------
// R4a — inventory and pinned shape.
// ---------------------------------------------------------------------------

describe("task suite inventory and shape", () => {
  it("has exactly 18 tasks with unique, well-formed ids", () => {
    expect(TASKS).toHaveLength(18);
    const ids = TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(18);
    for (const id of ids) {
      expect(id).toMatch(/^(synth-(needle|multihop|update|count)-[123]|code-(needle|execute|bug)-[12])$/);
    }
  });

  it("is 12 synthetic + 6 coding with the required per-category verify types", () => {
    expect(TASKS.filter((t) => t.kind === "synthetic")).toHaveLength(12);
    expect(TASKS.filter((t) => t.kind === "coding")).toHaveLength(6);
    for (const n of [1, 2, 3]) {
      expect(task(`synth-needle-${n}`).verify.type).toBe("contains");
      expect(task(`synth-multihop-${n}`).verify.type).toBe("contains");
      expect(task(`synth-update-${n}`).verify.type).toBe("contains");
      expect(task(`synth-count-${n}`).verify.type).toBe("numeric");
    }
    expect(task("code-needle-1").verify.type).toBe("contains");
    expect(task("code-needle-2").verify.type).toBe("contains");
    expect(task("code-execute-1").verify.type).toBe("exact");
    expect(task("code-execute-2").verify.type).toBe("exact");
    expect(task("code-bug-1").verify.type).toBe("contains");
    expect(task("code-bug-2").verify.type).toBe("contains");
  });

  it("gives every task the pinned system + haystack + question message shape", () => {
    for (const t of TASKS) {
      expect(t.messages.length).toBe(3);
      expect(t.messages[0]!.role).toBe("system");
      expect(t.messages[1]!.role).toBe("user");
      const last = t.messages[t.messages.length - 1]!;
      expect(last.role).toBe("user");
      for (const m of t.messages) {
        expect(m.content.length).toBeGreaterThan(0);
      }
      expect(t.haystackTokens).toBeGreaterThan(0);
      expect(t.verify.expected.length).toBeGreaterThan(0);
      expect(t.kind === "synthetic" || t.kind === "coding").toBe(true);
    }
  });

  it("mixes synthetic haystack tiers ~3k / ~8k / ~15k tokens (4 tasks each)", () => {
    const tiers = [3000, 8000, 15000];
    for (const tier of tiers) {
      const atTier = TASKS.filter(
        (t) => t.kind === "synthetic" && Math.abs(t.haystackTokens - tier) <= 0.25 * tier,
      );
      expect(atTier, `tier ${tier}`).toHaveLength(4);
    }
    for (const n of [1, 2, 3]) {
      for (const cat of ["needle", "multihop", "update", "count"]) {
        const t = task(`synth-${cat}-${n}`);
        expect(Math.abs(t.haystackTokens - tiers[n - 1]!)).toBeLessThanOrEqual(0.25 * tiers[n - 1]!);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// R4b — synthetic grounding: planted facts exist verbatim, exactly once,
// and the verify answers are re-derived from the haystack text itself.
// ---------------------------------------------------------------------------

describe("synthetic needle tasks", () => {
  for (const n of [1, 2, 3]) {
    it(`synth-needle-${n}: certification fact is grounded and unique`, () => {
      const t = task(`synth-needle-${n}`);
      const hay = haystackOf(t);
      const grounds = GROUNDINGS[t.id]!;
      expect(grounds).toHaveLength(1);
      expect(hay).toContain(grounds[0]!); // grounding sentence verbatim
      // Re-derive the answer from the planted sentence itself.
      const m = /Vessel ([A-Z]+-\d)'s certification code is ([A-Z]{2}-\d+)\./.exec(grounds[0]!);
      expect(m).not.toBeNull();
      const [, ship, code] = m!;
      expect(t.verify.expected).toBe(code);
      // The code occurs exactly once in the haystack, and the question
      // names the vessel but never leaks the code.
      expect(occurrences(hay, code)).toBe(1);
      const question = t.messages[2]!.content;
      expect(question).toContain(ship);
      expect(question).not.toContain(code);
    });
  }
});

describe("synthetic multihop tasks", () => {
  for (const n of [1, 2, 3]) {
    it(`synth-multihop-${n}: both join facts grounded; join is genuinely two-hop`, () => {
      const t = task(`synth-multihop-${n}`);
      const hay = haystackOf(t);
      const grounds = GROUNDINGS[t.id]!;
      expect(grounds).toHaveLength(2);
      for (const g of grounds) expect(hay).toContain(g);
      const a = /Cargo manifest ([A-Z]{3}-\d+) is loaded onto vessel ([A-Z]+-\d)\./.exec(grounds[0]!);
      const b = /Vessel ([A-Z]+-\d) is scheduled to dock at sector ([A-Z]{2}-\d)\./.exec(grounds[1]!);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      const [, cargoId, shipA] = a!;
      const [, shipB, sector] = b!;
      // The two facts join ONLY through the shared vessel id.
      expect(shipA).toBe(shipB);
      expect(t.verify.expected).toBe(sector);
      // No single line links cargo to sector directly.
      expect(grounds[0]!).not.toContain(sector);
      expect(grounds[1]!).not.toContain(cargoId);
      // Sector code and asked cargo id each occur exactly once in the
      // haystack, so the answer cannot be guessed from filler.
      expect(occurrences(hay, sector)).toBe(1);
      expect(occurrences(hay, cargoId)).toBe(1);
      const question = t.messages[2]!.content;
      expect(question).toContain(cargoId);
      expect(question).not.toContain(sector);
    });
  }
});

describe("synthetic update-tracking tasks", () => {
  for (const n of [1, 2, 3]) {
    it(`synth-update-${n}: original AND revised statements exist; answer is the revision`, () => {
      const t = task(`synth-update-${n}`);
      const hay = haystackOf(t);
      const grounds = GROUNDINGS[t.id]!;
      expect(grounds).toHaveLength(2);
      for (const g of grounds) expect(hay).toContain(g);
      const o = /originally set to ([A-Z]{2}-\d+)\./.exec(grounds[0]!);
      const r = /the current value is ([A-Z]{2}-\d+)\./.exec(grounds[1]!);
      expect(o).not.toBeNull();
      expect(r).not.toBeNull();
      const original = o![1]!;
      const revised = r![1]!;
      expect(original).not.toBe(revised);
      expect(t.verify.expected).toBe(revised);
      // Both values occur exactly once, and the original is stated
      // strictly BEFORE the revision (a real update ordering).
      expect(occurrences(hay, original)).toBe(1);
      expect(occurrences(hay, revised)).toBe(1);
      const idxOrig = hay.indexOf(original);
      const idxRev = hay.indexOf(revised);
      expect(idxOrig).toBeLessThan(idxRev);
      expect(t.messages[2]!.content).toContain("CURRENT");
    });
  }
});

describe("synthetic count-aggregate tasks", () => {
  for (const n of [1, 2, 3]) {
    it(`synth-count-${n}: recount of flagged vessels matches the numeric ground truth`, () => {
      const t = task(`synth-count-${n}`);
      const hay = haystackOf(t);
      const zone = /zone ([A-Z]{2}-\d) across the log\?/.exec(t.messages[2]!.content);
      expect(zone).not.toBeNull();
      const z = zone![1]!;
      // Recount by scanning the haystack — the generator's counter is
      // never trusted here.
      const re = new RegExp(`Vessel ([A-Z]+-\\d) flagged for inspection in zone ${z}(?!\\d)`, "g");
      const ships: string[] = [];
      for (const m of hay.matchAll(re)) ships.push(m[1]!);
      expect(t.verify.expected).toMatch(/^\d+$/);
      expect(ships.length).toBe(Number(t.verify.expected));
      // All flagged vessels are distinct, so "how many vessels" equals
      // the entry count (asserted property of the generated data).
      expect(new Set(ships).size).toBe(ships.length);
      // The planted zone really is the asked zone, and decoys exist:
      // routine passes in the asked zone plus flagged entries in OTHER
      // zones must not have been counted above.
      const allFlagged = [...hay.matchAll(/flagged for inspection in zone ([A-Z]{2}-\d)(?!\d)/g)].map((m) => m[1]!);
      expect(allFlagged.filter((zc) => zc === z)).toHaveLength(ships.length);
      expect(allFlagged.filter((zc) => zc !== z).length).toBeGreaterThan(0);
      expect(occurrences(hay, `passed routine inspection in zone ${z}`)).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// R4c — coding tasks: answers re-derived from the fixture on disk and by
// re-executing the real fixture functions.
// ---------------------------------------------------------------------------

function fixtureSource(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

describe("coding comprehension tasks", () => {
  const coding = TASKS.filter((t) => t.kind === "coding");
  const first = coding[0]!;

  it("embeds all 10 fixture files in every coding haystack", () => {
    const names = readdirSync(fixtureDir).filter((f) => f.endsWith(".ts"));
    expect(names).toHaveLength(10);
    for (const t of coding) {
      const hay = haystackOf(t);
      for (const name of names) {
        expect(hay).toContain(`----- FILE: ${name} -----`);
        expect(hay).toContain(fixtureSource(name));
      }
    }
  });

  it("code-needle-1: expected file#function is the unique exporter on disk", () => {
    const t = task("code-needle-1");
    const names = readdirSync(fixtureDir).filter((f) => f.endsWith(".ts"));
    const exporters = names.filter((n) =>
      /export function splitCsvLine\b/.test(fixtureSource(n)),
    );
    expect(exporters).toEqual(["csv.ts"]);
    expect(t.verify.expected).toBe("csv.ts#splitCsvLine");
    // Exactly one occurrence in the haystack too.
    expect(occurrences(haystackOf(t), "export function splitCsvLine")).toBe(1);
  });

  it("code-needle-2: expected default re-extracted from config-loader.ts", () => {
    const t = task("code-needle-2");
    const defaults = [...fixtureSource("config-loader.ts").matchAll(/timeoutMs:\s*(\d+)/g)];
    expect(defaults).toHaveLength(1);
    expect(t.verify.expected).toBe(defaults[0]![1]!);
    expect(haystackOf(t)).toContain(`timeoutMs: ${t.verify.expected}`);
  });

  it("code-execute-1: expected output recomputed by calling titleCase", () => {
    const t = task("code-execute-1");
    const input = /titleCase\("([^"]+)"\)/.exec(t.messages[2]!.content);
    expect(input).not.toBeNull();
    expect(t.verify.expected).toBe(titleCase(input![1]!));
    expect(t.verify.expected.length).toBeGreaterThan(0);
  });

  it("code-execute-2: expected output recomputed by calling formatBytes", () => {
    const t = task("code-execute-2");
    const input = /formatBytes\((\d+)\)/.exec(t.messages[2]!.content);
    expect(input).not.toBeNull();
    expect(t.verify.expected).toBe(formatBytes(Number(input![1]!)));
    expect(t.verify.expected.length).toBeGreaterThan(0);
  });

  it("code-bug-1: expected is the single buggy leap-year line from date-format.ts", () => {
    const t = task("code-bug-1");
    const expected = t.verify.expected;
    expect(expected).not.toMatch(/\n/); // a single line
    expect(expected).toContain("year % 100 !== 0");
    expect(fixtureSource("date-format.ts")).toContain(expected);
    expect(haystackOf(t)).toContain(expected);
    expect(haystackOf(first)).toContain("export function isLeapYear");
  });

  it("code-bug-2: expected is the single buggy isFull line from queue.ts", () => {
    const t = task("code-bug-2");
    const expected = t.verify.expected;
    expect(expected).not.toMatch(/\n/);
    expect(expected).toContain("capacity - 1");
    expect(fixtureSource("queue.ts")).toContain(expected);
    expect(haystackOf(t)).toContain(expected);
    expect(haystackOf(first)).toContain("isFull(): boolean");
  });
});

// ---------------------------------------------------------------------------
// R4d — determinism and contamination.
// ---------------------------------------------------------------------------

describe("determinism and contamination", () => {
  it("builds a byte-identical suite on regeneration (deep-equal)", () => {
    const second = buildSuite();
    expect(second.tasks).toEqual(TASKS);
    expect(second.groundings).toEqual(GROUNDINGS);
    expect(JSON.stringify(second.tasks)).toBe(JSON.stringify(TASKS));
  });

  it("contains no real-world named entities (blocklist scan)", () => {
    const blocklist = new RegExp(
      "\\b(claude|gpt|chatgpt|openai|anthropic|gemini|llama|mistral|deepseek|copilot|" +
        "bertrand|pocock|matt|turing|knuth|ritchie|" +
        "react|angular|vue|jquery|lodash|express|fastify|webpack|vite|vitest|jest|" +
        "typescript|javascript|node|npm|github|stackoverflow|wikipedia|" +
        "rust|python|java|linux|windows|macos|" +
        "ollama|openrouter|docker|kubernetes|pytorch|tensorflow|" +
        "paris|london|tokyo|singapore|rotterdam|antwerp|hamburg|shanghai)\\b",
      "i",
    );
    const serialized = JSON.stringify(TASKS);
    const hit = blocklist.exec(serialized);
    expect(hit ? `blocklisted entity found: ${hit[0]}` : "clean").toBe("clean");
  });

  it("uses no Math.random, Date.now, or clock reads in the generators", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts")) files.push(p);
      }
    };
    walk(tasksDir);
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const f of files) {
      expect(readFileSync(f, "utf8")).not.toMatch(/Math\.random\s*\(|Date\.now\s*\(/);
    }
  });
});
