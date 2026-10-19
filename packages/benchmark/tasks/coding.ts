// Coding-comprehension suite (6 tasks over ONE embedded mini-repo fixture:
// tasks/fixture-repo, a realistic 10-file utility project with two
// intentional warts documented only in the notes below).
//
// Ground truths are derived from the fixture itself, never hand-typed:
//   needle  #1 — the file exporting the asked function is found by scanning
//                every fixture file (throwing unless exactly one matches);
//   needle  #2 — the default value is extracted from config-loader.ts's
//                DEFAULTS table by regex at build time;
//   execute    — expected outputs are COMPUTED by importing and calling the
//                real fixture functions (titleCase / formatBytes);
//   bug-quote  — expected is the literal buggy line, extracted from the
//                fixture file by anchor+marker scan, so a strategy that
//                drops the file's content cannot quote it.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkTask, TaskVerify } from "./types.js";
import { titleCase } from "./fixture-repo/string-utils.js";
import { formatBytes } from "./fixture-repo/units.js";

const SYSTEM =
  "You are a meticulous code analyst. You will be given the complete source " +
  "of a small utility repository, then one question about it. Answer from " +
  "the repository source only.";

// Inputs for the exact-output tasks (pinned so the question text, the regex
// that re-extracts them in the test, and the executed call stay in sync).
const TITLE_INPUT = "tHE ORTUNDA-7 MANIFEST";
const BYTES_INPUT = 1572864;

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixture-repo");

interface FixtureFile {
  name: string;
  content: string;
}

function fixtureFiles(): FixtureFile[] {
  return readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(fixtureDir, name), "utf8") }));
}

// --- derivation helpers (all throw when the fixture drifts) -----------------

function exportingFile(files: FixtureFile[], fnName: string): string {
  const re = new RegExp(`export function ${fnName}\\b`);
  const hits = files.filter((f) => re.test(f.content));
  if (hits.length !== 1) {
    throw new Error(`expected exactly one fixture file exporting ${fnName}, found ${hits.length}`);
  }
  return hits[0]!.name;
}

function defaultNumber(files: FixtureFile[], fileName: string, key: string): string {
  const file = files.find((f) => f.name === fileName);
  if (!file) throw new Error(`fixture file not found: ${fileName}`);
  const re = new RegExp(`${key}:\\s*(\\d+)`, "g");
  const hits = [...file.content.matchAll(re)].map((m) => m[1] ?? "");
  if (hits.length !== 1) {
    throw new Error(`expected exactly one '${key}:' default in ${fileName}, found ${hits.length}`);
  }
  return hits[0]!;
}

function quotedLine(files: FixtureFile[], fileName: string, anchor: string, marker: RegExp): string {
  const file = files.find((f) => f.name === fileName);
  if (!file) throw new Error(`fixture file not found: ${fileName}`);
  const lines = file.content.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(anchor));
  if (start < 0) throw new Error(`anchor not found in ${fileName}: ${anchor}`);
  const found = lines.slice(start, start + 10).find((l) => marker.test(l));
  if (!found) throw new Error(`wart line not found near '${anchor}' in ${fileName}`);
  return found.trim();
}

// --- task assembly ----------------------------------------------------------

function assemble(
  id: string,
  haystack: string,
  question: string,
  verify: TaskVerify,
  notes: string,
): BenchmarkTask {
  const messages: BenchmarkTask["messages"] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: haystack },
    { role: "user", content: question },
  ];
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return { id, kind: "coding", haystackTokens: Math.round(chars / 4), messages, verify, notes };
}

export function buildCodingTasks(): {
  tasks: BenchmarkTask[];
  groundings: Record<string, string[]>;
} {
  const files = fixtureFiles();
  const haystack =
    `The complete source of the qtil utility repository follows (${files.length} files, concatenated).\n\n` +
    files.map((f) => `----- FILE: ${f.name} -----\n${f.content}`).join("\n");

  // Derived ground truths (computed/extracted from the fixture on disk).
  const csvFile = exportingFile(files, "splitCsvLine");
  const csvAnswer = `${csvFile}#splitCsvLine`;
  const timeoutDefault = defaultNumber(files, "config-loader.ts", "timeoutMs");
  const titleAnswer = titleCase(TITLE_INPUT); // executed for real
  const bytesAnswer = formatBytes(BYTES_INPUT); // executed for real
  const leapLine = quotedLine(files, "date-format.ts", "export function isLeapYear", /% 100 !== 0/);
  const fullLine = quotedLine(files, "queue.ts", "isFull(): boolean", /capacity - 1/);

  return {
    tasks: [
      assemble(
        "code-needle-1",
        haystack,
        "Which file in the repository below exports the function that splits a single CSV line " +
          "into cells while respecting quoted separators? Reply in the exact form file.ts#functionName.",
        { type: "contains", expected: csvAnswer },
        "File-location needle. Ground truth derived by scanning every fixture file for the " +
          "unique exporter of the asked function (the generator throws unless exactly one " +
          "file matches); the question describes behavior, the answer names file and function.",
      ),
      assemble(
        "code-needle-2",
        haystack,
        "According to the repository below, what is the default value of the timeoutMs option " +
          "in loadConfig? Reply with the literal number exactly as written in the source.",
        { type: "contains", expected: timeoutDefault },
        "Default-value needle. Ground truth extracted from the DEFAULTS table in " +
          "fixture-repo/config-loader.ts by regex at build time, never hand-typed.",
      ),
      assemble(
        "code-execute-1",
        haystack,
        `According to string-utils.ts in the repository below, what exactly does ` +
          `titleCase("${TITLE_INPUT}") return? Reply with the exact returned string and nothing else.`,
        { type: "exact", expected: titleAnswer },
        "Exact-output comprehension. Ground truth computed by importing and calling the real " +
          "titleCase from fixture-repo/string-utils.ts at build time.",
      ),
      assemble(
        "code-execute-2",
        haystack,
        `According to units.ts in the repository below, what exactly does ` +
          `formatBytes(${BYTES_INPUT}) return? Reply with the exact returned string and nothing else.`,
        { type: "exact", expected: bytesAnswer },
        "Exact-output comprehension. Ground truth computed by importing and calling the real " +
          "formatBytes from fixture-repo/units.ts at build time.",
      ),
      assemble(
        "code-bug-1",
        haystack,
        "The isLeapYear function in the repository below has a subtle bug: it returns the wrong " +
          "answer for some years. Quote the exact line containing the buggy condition. Reply with " +
          "that single line only.",
        { type: "contains", expected: leapLine },
        "Intentional fixture wart #1 (documented here, not in the fixture): isLeapYear omits the " +
          "divisible-by-400 exception, so century years like 2000 are misclassified. Ground truth " +
          "is the literal buggy line extracted from fixture-repo/date-format.ts; a strategy that " +
          "drops that file cannot quote it.",
      ),
      assemble(
        "code-bug-2",
        haystack,
        "The isFull method of the CircularQueue class in the repository below has an off-by-one " +
          "bug: it reports the queue as full one entry too early. Quote the exact line containing " +
          "the buggy comparison. Reply with that single line only.",
        { type: "contains", expected: fullLine },
        "Intentional fixture wart #2 (documented here, not in the fixture): CircularQueue.isFull " +
          "compares size against capacity - 1, so the last slot is never used. Ground truth is " +
          "the literal buggy line extracted from fixture-repo/queue.ts.",
      ),
    ],
    groundings: {},
  };
}
