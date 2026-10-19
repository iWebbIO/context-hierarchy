// Proxy entry point (task-6 brief R4).
//
// `startProxy(cfg?)` — the programmatic surface: load/merge config, wire the
// real stack, listen (port 0 = ephemeral), resolve the actual URL. The CLI
// path (running `node dist/main.js`) logs exactly ONE startup line: port +
// upstream host — never the API key, never the full upstream URL with
// credentials. A config error exits with the message naming the variable.

import { pathToFileURL } from "node:url";
import type { ProxyConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { buildFromConfig } from "./server.js";

/** Host of the upstream base URL for the startup line (best-effort). */
function upstreamHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "(unparseable upstream URL)";
  }
}

/**
 * Boot the proxy programmatically. `cfg` (a `Partial<ProxyConfig>`) overrides
 * the environment/`.env` for every field it sets. Resolves once listening,
 * with the actual URL (`port: 0` → the OS-assigned ephemeral port) and a
 * `close()` that shuts the server down.
 */
export async function startProxy(
  cfg: Partial<ProxyConfig> = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const config = loadConfig(cfg);
  const app = buildFromConfig(config);
  await app.listen({ port: config.port, host: "127.0.0.1" });
  const address = app.addresses()[0];
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}

/** True when this module is the process entry (`node …/dist/main.js`). */
function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const cfg = loadConfig();
  startProxy(cfg)
    .then(({ url }) => {
      console.log(
        `context-hierarchy proxy listening on ${url} ` +
          `(upstream: ${upstreamHost(cfg.upstreamBaseUrl)}, model: ${cfg.upstreamModel}, ` +
          `cap: ${cfg.capTokens} tokens, strategy: ${cfg.strategy})`,
      );
    })
    .catch((e: unknown) => {
      console.error(
        `Failed to start context-hierarchy proxy: ${e instanceof Error ? e.message : String(e)}`,
      );
      process.exit(1);
    });
}
