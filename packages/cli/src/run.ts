#!/usr/bin/env node
// ctxh — the context-hierarchy coding-harness CLI (brief R2).
//
// Three commands over the same landed core:
//   ctxh serve   boots the OpenAI-compatible proxy (startProxy) — the server
//                front door. ONE startup line: port + upstream host, never
//                the API key and never a URL that could carry credentials.
//                Ctrl-C closes the server cleanly.
//   ctxh ask      one-shot question through the IN-PROCESS capped engine
//                (ProviderAdapter → TokenAccountant → strategy → FleetEngine).
//                Prints the answer to stdout; --stats adds a compact sub-call
//                summary. Upstream errors exit non-zero with the message on
//                stderr.
//   ctxh config   the EFFECTIVE config: upstream HOST only, the API key
//                masked as set/unset, and the data dir path.
//
// Arg parsing is hand-rolled (no dep): flags may appear anywhere, `--flag
// value` and `--flag=value` both work, an unknown flag (or any usage error)
// prints the usage text and exits 2.
//
// Structure for testability: parseArgs / formatConfig / runAsk are exported
// pure-ish units, and `main` takes an injectable IO plus an injectable
// `runAsk` (the same DI pattern the proxy's buildServer uses) so the command
// dispatch — including exactly what would print and the exit codes — is
// tested without a model, a server, or a network.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, startProxy } from "@context-hierarchy/proxy";
import type { ProxyConfig } from "@context-hierarchy/proxy";
import type { ProviderAdapter, SubCallEvent } from "@context-hierarchy/core";
import { buildEngineStack } from "./engine-stack.js";
import { formatSubCallSummary } from "./ask-print.js";

// ---------------------------------------------------------------------------
// Usage text (kept in one place; the help/no-args path prints it verbatim).
// ---------------------------------------------------------------------------

export const USAGE = `ctxh — the context-hierarchy coding harness

Usage:
  ctxh serve [--port N]           start the capped OpenAI-compatible proxy
  ctxh ask "<question>" [--cap N] [--model M] [--stats]
                                  ask one question through the capped engine
  ctxh config                     print the effective config (API key masked)
  ctxh help                       print this text

Configuration comes from the environment and a .env file in the working
directory: UPSTREAM_BASE_URL, UPSTREAM_API_KEY, UPSTREAM_MODEL, CAP_TOKENS,
STRATEGY, PORT, DATA_DIR. The API key is never printed or logged.

Exit codes: 0 ok, 1 runtime/upstream error, 2 usage error.`;

// ---------------------------------------------------------------------------
// Hand-rolled arg parsing.
// ---------------------------------------------------------------------------

export type CliCommand = "serve" | "ask" | "config" | "help";

/** What parseArgs produced; `command` undefined means "no args" (→ help). */
export interface ParsedArgs {
  command?: CliCommand;
  question?: string;
  port?: number;
  cap?: number;
  model?: string;
  stats: boolean;
}

/** A usage error: main prints the message + usage and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Non-negative integer flag value, or a UsageError naming the flag. */
function intFlag(name: string, raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${name} expects a non-negative integer, got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Parse a `ctxh` argument vector (argv without `node` and the script path).
 * Flags may appear anywhere; `--port 3000` and `--port=3000` are equivalent.
 * Throws UsageError for anything not in the grammar above.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { stats: false };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`missing value for ${name}`);
      return next;
    };
    switch (name) {
      case "--port":
        parsed.port = intFlag(name, value());
        break;
      case "--cap":
        parsed.cap = intFlag(name, value());
        break;
      case "--model":
        parsed.model = value();
        break;
      case "--stats":
        if (inlineValue !== undefined) throw new UsageError("--stats takes no value");
        parsed.stats = true;
        break;
      default:
        throw new UsageError(`unknown flag: ${name}`);
    }
  }

  const [command, ...rest] = positional;
  if (command === undefined) return parsed; // no args → help
  if (command !== "serve" && command !== "ask" && command !== "config" && command !== "help") {
    throw new UsageError(`unknown command: ${command}`);
  }
  parsed.command = command;
  if (command === "ask") {
    if (rest.length < 1) {
      throw new UsageError(`ask requires a question: ctxh ask "<question>"`);
    }
    if (rest.length > 1) {
      throw new UsageError(
        `ask takes exactly one question (quote it) — got ${rest.length} arguments`,
      );
    }
    parsed.question = rest[0];
  } else if (rest.length > 0) {
    throw new UsageError(`'${command}' takes no positional arguments`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// config — the effective config, key masked, host only.
// ---------------------------------------------------------------------------

/** Upstream HOST for display (never the full URL, never anything with a key). */
function upstreamHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "(unparseable upstream URL)";
  }
}

/**
 * The `ctxh config` lines: upstream host (host only), model, key masked as
 * set/unset, cap, strategy, port, and the resolved data dir path.
 */
export function formatConfig(cfg: ProxyConfig): string[] {
  return [
    `upstream host: ${upstreamHost(cfg.upstreamBaseUrl)}`,
    `upstream model: ${cfg.upstreamModel}`,
    `upstream api key: ${cfg.upstreamApiKey === "" ? "unset" : "set"}`,
    `proxy api key: ${cfg.proxyApiKey === "" ? "unset" : "set"}`,
    `cap: ${cfg.capTokens} tokens`,
    `strategy: ${cfg.strategy}`,
    `port: ${cfg.port}`,
    `data dir: ${resolve(cfg.dataDir)}`,
  ];
}

// ---------------------------------------------------------------------------
// ask — one question through the in-process stack.
// ---------------------------------------------------------------------------

/** What `ctxh ask` needs; `adapter`/`config` are seams for tests. */
export interface AskOptions {
  question: string;
  /** --cap: overrides CAP_TOKENS for this question. */
  capTokens?: number;
  /** --model: overrides UPSTREAM_MODEL for this question. */
  model?: string;
  /** Test seam: a scripted adapter instead of the real HTTP one. */
  adapter?: ProviderAdapter;
  /** Extra loadConfig overrides (tests pin a fake upstream; the live smoke pins the real one). */
  config?: Partial<ProxyConfig>;
}

/** What `ctxh ask` produced — printing is main's job, this is the payload. */
export interface AskResult {
  answer: string;
  degraded: boolean;
  events: SubCallEvent[];
}

/**
 * Run one question as a single user message through the capped engine and
 * return what should print (main formats it). Rejects with the upstream
 * error on failure — main maps that to stderr + exit 1.
 */
export async function runAsk(opts: AskOptions): Promise<AskResult> {
  const overrides: Partial<ProxyConfig> = { ...opts.config };
  if (opts.capTokens !== undefined) overrides.capTokens = opts.capTokens;
  if (opts.model !== undefined) overrides.upstreamModel = opts.model;
  const cfg = loadConfig(overrides);

  const stack = buildEngineStack({
    baseUrl: cfg.upstreamBaseUrl,
    apiKey: cfg.upstreamApiKey,
    model: cfg.upstreamModel,
    capTokens: cfg.capTokens,
    dataDir: cfg.dataDir,
    strategy: cfg.strategy,
    adapter: opts.adapter,
  });

  const result = await stack.engine.run({
    model: cfg.upstreamModel,
    messages: [{ role: "user", content: opts.question }],
  });
  return {
    answer: result.content,
    degraded: result.degraded === true,
    events: [...stack.events],
  };
}

// ---------------------------------------------------------------------------
// main — dispatch, printing, exit codes.
// ---------------------------------------------------------------------------

/** Injectable output (tests capture lines instead of touching the console). */
export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

const consoleIO: CliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Injectable command internals — the same DI pattern the proxy uses. */
export interface CliDeps {
  /** Override runAsk (tests script it; production uses the real one). */
  runAsk?: typeof runAsk;
}

/** `ctxh serve`: boot the proxy, log ONE line, close cleanly on Ctrl-C. */
async function serveCommand(port: number | undefined, io: CliIO): Promise<number> {
  const cfg = loadConfig(port !== undefined ? { port } : {});
  const { url, close } = await startProxy(cfg);
  io.out(
    `ctxh serve: proxy listening on ${url} ` +
      `(upstream host: ${upstreamHost(cfg.upstreamBaseUrl)}, model: ${cfg.upstreamModel}, ` +
      `cap: ${cfg.capTokens} tokens, strategy: ${cfg.strategy})`,
  );
  const shutdown = (): void => {
    void close()
      .catch(() => {})
      .then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return 0; // the listening server keeps the process alive
}

/**
 * Run the CLI for an argument vector and return the exit code (0 ok,
 * 1 runtime/upstream error, 2 usage). Prints go through `io`; `deps.runAsk`
 * lets tests drive the ask path without a model.
 */
export async function main(
  argv: readonly string[],
  io: CliIO = consoleIO,
  deps: CliDeps = {},
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`ctxh: ${e.message}`);
      io.err(USAGE);
      return 2;
    }
    throw e;
  }

  const ask = deps.runAsk ?? runAsk;
  try {
    switch (parsed.command ?? "help") {
      case "help":
        io.out(USAGE);
        return 0;
      case "config":
        for (const line of formatConfig(loadConfig())) io.out(line);
        return 0;
      case "serve":
        return await serveCommand(parsed.port, io);
      case "ask": {
        const result = await ask({
          question: parsed.question!,
          capTokens: parsed.cap,
          model: parsed.model,
        });
        io.out(result.answer);
        if (result.degraded) {
          io.err("ctxh: degraded — the fleet failed; answered with one capped call");
        }
        if (parsed.stats) {
          for (const line of formatSubCallSummary(result.events)) io.out(line);
        }
        return 0;
      }
    }
  } catch (e) {
    io.err(`ctxh: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Bin entry — run only when this module is the process entry.
// ---------------------------------------------------------------------------

/** True when this module is the process entry (`node …/dist/run.js`, `ctxh`). */
function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).then((code) => {
    if (code > 0) process.exit(code);
    // code 0: let the event loop drain naturally (serve stays alive on its
    // listening handle; everything else has nothing pending and exits 0).
  });
}
