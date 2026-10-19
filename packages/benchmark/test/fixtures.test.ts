// Real-suite dry-run test (brief: "dry-run output of the real task
// inventory IF tasks/ has landed" — it has). This test consumes the REAL
// task suites through the shipped loader and asserts the exact pre-flight
// behavior, including the grid-plan math on the way.
//
// Still no network, no .env: --dry-run resolves no configuration and makes no
// model calls (that is the assertion that matters).

import { describe, expect, it } from "vitest";
import { main } from "../src/run.js";
import { loadTasks } from "../src/tasks.js";

describe("real-suite dry-run", () => {
  it("prints the grid plan and the full real task inventory, touching no config", async () => {
    const tasks = await loadTasks(); // the REAL pinned suites from tasks/
    const lines: string[] = [];
    let configReads = 0;
    const code = await main(
      [
        "--dry-run",
        "--arms",
        "fleet,map-reduce,solo-hierarchy,truncation,uncapped",
        "--tasks",
        "all",
      ],
      {
        loadTasks: async () => tasks,
        loadConfig: () => {
          configReads++;
          throw new Error("dry-run must never resolve configuration");
        },
        stdout: (line) => lines.push(line),
      },
    );
    expect(code).toBe(0);
    expect(configReads).toBe(0);

    const out = lines.join("\n");
    // Plan math: 4 capped arms × 4 default caps × 1 trial, plus the uncapped
    // reference ONCE per task — 17 runs per task regardless of cap count.
    expect(out).toContain(`runs: ${tasks.length * (4 * 4 * 1 + 1)} `);
    expect(out).toContain(`task inventory (${tasks.length} selected):`);
    for (const task of tasks) {
      expect(out).toContain(task.id);
    }
  });
});
