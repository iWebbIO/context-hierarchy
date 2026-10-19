// The single seam through which the rig consumes the benchmark task suites
// owned by the tasks track (`tasks/index.js`).
//
// WHY a runtime dynamic import instead of the pinned static form
// (`import { TASKS } from "../tasks/index.js"`): tasks/ is owned by a PARALLEL
// track and does not exist while the rig is being developed. A static import
// — the correct end-state form once tasks/ has landed — breaks `tsc -p .`,
// the repo-root typecheck, and (where executed) vitest until that directory
// exists. The computed specifier below is invisible to the type checker, so
// the rig typechecks, builds, and tests standalone; every loaded task is then
// validated at runtime against the pinned format (src/types.ts), so a
// drifted task suite still fails loudly.
//
// The loader tries the compiled `index.js` first, then the TypeScript source
// `index.ts`: Node >= 23.6 strips erasable TypeScript natively (the pinned
// task format — interfaces and `import type` — is erasable-only), and vitest
// resolves either. A runtime error names both attempted locations.

import type { BenchmarkTask } from "./types.js";

const VERIFY_TYPES: ReadonlySet<string> = new Set(["exact", "contains", "numeric"]);

/** Error message helper for the loader and validator. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate a loaded task list against the pinned format (brief §"Pinned task
 * format"). Throws with a precise, task-locating message on the first
 * violation; returns the same array typed.
 */
export function validateTasks(raw: unknown): BenchmarkTask[] {
  if (!Array.isArray(raw)) {
    throw new Error(`TASKS must be an array of benchmark tasks (got ${typeof raw})`);
  }
  const seen = new Set<string>();
  return raw.map((entry, i): BenchmarkTask => {
    const where = `TASKS[${i}]`;
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${where}: expected an object`);
    }
    const task = entry as Record<string, unknown>;
    if (typeof task.id !== "string" || task.id === "") {
      throw new Error(`${where}: id must be a non-empty string`);
    }
    if (seen.has(task.id)) {
      throw new Error(`${where}: duplicate task id ${JSON.stringify(task.id)}`);
    }
    seen.add(task.id);
    if (task.kind !== "synthetic" && task.kind !== "coding") {
      throw new Error(`${where} (${task.id}): kind must be "synthetic" or "coding"`);
    }
    if (typeof task.haystackTokens !== "number" || !Number.isFinite(task.haystackTokens)) {
      throw new Error(`${where} (${task.id}): haystackTokens must be a finite number`);
    }
    if (!Array.isArray(task.messages) || task.messages.length === 0) {
      throw new Error(`${where} (${task.id}): messages must be a non-empty array`);
    }
    for (let j = 0; j < task.messages.length; j++) {
      const message = task.messages[j] as Record<string, unknown> | null;
      if (typeof message !== "object" || message === null) {
        throw new Error(`${where} (${task.id}): messages[${j}] must be an object`);
      }
      if (typeof message.role !== "string" || typeof message.content !== "string") {
        throw new Error(`${where} (${task.id}): messages[${j}] needs string role and content`);
      }
    }
    if (typeof task.verify !== "object" || task.verify === null) {
      throw new Error(`${where} (${task.id}): verify must be an object`);
    }
    const verify = task.verify as Record<string, unknown>;
    if (typeof verify.type !== "string" || !VERIFY_TYPES.has(verify.type)) {
      throw new Error(
        `${where} (${task.id}): verify.type must be "exact", "contains" or "numeric"`,
      );
    }
    if (typeof verify.expected !== "string") {
      throw new Error(`${where} (${task.id}): verify.expected must be a string`);
    }
    if (task.notes !== undefined && typeof task.notes !== "string") {
      throw new Error(`${where} (${task.id}): notes must be a string`);
    }
    return entry as BenchmarkTask;
  });
}

/**
 * Load the pinned task suites from tasks/. Resolution order:
 * `tasks/index.js` (compiled) then `tasks/index.ts` (source, Node >= 23.6).
 * Throws a descriptive error when neither exists.
 */
export async function loadTasks(): Promise<BenchmarkTask[]> {
  let mod: { TASKS?: unknown } | undefined;
  let lastError: unknown = undefined;
  for (const file of ["index.js", "index.ts"]) {
    try {
      mod = (await import(new URL(`../tasks/${file}`, import.meta.url).href)) as {
        TASKS?: unknown;
      };
      break;
    } catch (error) {
      lastError = error;
      // Only a missing module falls through to the next candidate; anything
      // else (syntax, a broken transitive import) surfaces immediately.
      const code = (error as { code?: string }).code;
      const notFound =
        code === "ERR_MODULE_NOT_FOUND" ||
        code === "ENOENT" ||
        code === "ERR_UNSUPPORTED_DIR_IMPORT" ||
        code === "ERR_UNKNOWN_FILE_EXTENSION" ||
        code === "ERR_UNSUPPORTED_RESOLVE_REQUEST";
      if (!notFound) throw error;
    }
  }
  if (mod === undefined) {
    throw new Error(
      `cannot load the benchmark task suites: packages/benchmark/tasks/index.{js,ts} not found ` +
        `(${errorMessage(lastError)}). The tasks track owns that directory.`,
    );
  }
  return validateTasks(mod.TASKS);
}
