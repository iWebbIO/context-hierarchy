// Ambient type surface for `@context-hierarchy/proxy` — exactly the parts the
// CLI consumes.
//
// WHY this exists: the proxy package's tsconfig does not emit declarations
// (`declaration` is off), so when this package's own `tsc -p .` build resolves
// `@context-hierarchy/proxy` through node_modules it finds `dist/index.js`
// with no sibling `dist/index.d.ts` and fails with TS7016. The repo-root
// typecheck never hits this (its tsconfig paths map the specifier to the
// proxy SOURCE), and vitest never hits it either (this package's
// vitest.config.ts aliases the specifier to the proxy source). This
// declaration covers only the fourth path: the package-local emit build.
//
// The declarations below are copied verbatim in shape from
// packages/proxy/src/config.ts and packages/proxy/src/main.ts. If the proxy's
// public surface changes, update this file — or, better, turn on `declaration`
// in the proxy's tsconfig and delete this file entirely.

declare module "@context-hierarchy/proxy" {
  /** Context-fitting strategy the proxy's engine runs. */
  export type StrategyName = "hierarchy" | "truncation";

  /** Fully-resolved proxy configuration (camelCase, env names in comments). */
  export interface ProxyConfig {
    /** UPSTREAM_BASE_URL — OpenAI-compatible base URL, version segment included. */
    upstreamBaseUrl: string;
    /** UPSTREAM_API_KEY — forwarded to the upstream, never logged. */
    upstreamApiKey: string;
    /** UPSTREAM_MODEL — every proxied call is routed to this model. */
    upstreamModel: string;
    /** CAP_TOKENS — hard per-model-call token cap (default 6000). */
    capTokens: number;
    /** PORT — listen port; 0 = ephemeral (default 8787). */
    port: number;
    /** STRATEGY — `hierarchy` (default) or `truncation`. */
    strategy: StrategyName;
    /** CONCURRENCY — max concurrent fleet sub-calls per request (default 3). */
    concurrency: number;
    /** DATA_DIR — calibration/spill/distillate/telemetry state (default `.ctxh`). */
    dataDir: string;
    /** PROXY_API_KEY — clients must present this as a Bearer token; empty = no gate. */
    proxyApiKey: string;
  }

  /**
   * Load the proxy configuration. `overrides` (a `Partial<ProxyConfig>`) wins
   * over the environment and `.env` for every field it sets.
   */
  export function loadConfig(overrides?: Partial<ProxyConfig>): ProxyConfig;

  /**
   * Boot the proxy programmatically. Resolves once listening, with the actual
   * URL (`port: 0` → the OS-assigned ephemeral port) and a `close()` that
   * shuts the server down.
   */
  export function startProxy(
    cfg?: Partial<ProxyConfig>,
  ): Promise<{ url: string; close(): Promise<void> }>;
}
