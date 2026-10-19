// ESM resolve hook for the plain-Node CLI path (registered by the entry guard
// in src/run.ts; vitest never runs it — tests resolve through vite's own
// remapping). The task suites ship TypeScript source with `.js`-suffixed
// internal imports, which TypeScript and vite remap to the `.ts` siblings but
// plain Node does not: when a `.js` import inside tasks/ fails with
// ERR_MODULE_NOT_FOUND, this hook retries the `.ts` sibling and passes
// everything else through untouched. The remapped modules are erasable-only
// TypeScript (Node >= 23.6 strips types natively); the non-erasable fixture
// files are only ever READ as haystack text, never imported.

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
