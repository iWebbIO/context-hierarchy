// A surgical ESM resolve hook for the PLAIN-NODE CLI path (registered by the
// entry guard in src/run.ts; vitest never runs it — tests resolve through
// vite's own remapping).
//
// WHY: the task suites (tasks/, owned by the tasks track) ship TypeScript
// SOURCE with `.js`-suffixed internal imports (canonical TS convention).
// TypeScript and vite remap `./coding.js` → `./coding.ts`; plain Node does
// NOT, so `node packages/benchmark/dist/run.js` could never consume the
// suites without a compiled `tasks/index.js` — which the tasks track does not
// emit (its sources are not in any tsc project).
//
// WHAT this hook does — and nothing more: when a `.js` import INSIDE the
// benchmark tasks directory fails with ERR_MODULE_NOT_FOUND, retry the `.ts`
// sibling. Everything else passes through untouched. The remapped modules
// must be erasable-only TypeScript (Node >= 23.6 strips types natively);
// empirically the suite's runtime import graph (index/coding/synthetic/rng)
// is, while the non-erasable fixture files (queue.ts, event-emitter.ts) are
// only ever READ as haystack text, never imported.

/** Node's module-customization hooks surface (stable since Node 20.6). */
interface ResolveContext {
  parentURL?: string;
}

interface Resolved {
  url: string;
  shortCircuit?: boolean;
  format?: string;
}

type NextResolve = (specifier: string, context: ResolveContext, next: NextResolve) => Resolved | Promise<Resolved>;

/** True when a parent/absolute URL sits inside the benchmark tasks directory. */
function insideTasks(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    return new URL(url).pathname.includes("/tasks/");
  } catch {
    return false;
  }
}

/** The `.ts` sibling candidate for a tasks-scoped `.js` specifier, if any. */
function tsCandidate(specifier: string): string | undefined {
  if (!specifier.endsWith(".js")) return undefined;
  if (specifier.startsWith("./") || specifier.startsWith("../")) return `${specifier.slice(0, -3)}.ts`;
  if (specifier.startsWith("file://") && insideTasks(specifier)) {
    return `${specifier.slice(0, -3)}.ts`;
  }
  return undefined;
}

export const resolve = async (
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<Resolved> => {
  try {
    return await nextResolve(specifier, context, nextResolve);
  } catch (error) {
    const code = (error as { code?: string }).code;
    const candidate = tsCandidate(specifier);
    // Only a missing module inside tasks/ is remapped; anything else (a real
    // missing dependency, a syntax error, …) surfaces unchanged.
    if (code === "ERR_MODULE_NOT_FOUND" && candidate !== undefined && insideTasks(context.parentURL)) {
      return nextResolve(candidate, context, nextResolve);
    }
    throw error;
  }
};
