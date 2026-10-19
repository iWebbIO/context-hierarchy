// Live E2E suite (task-7 brief R3) — the REAL proxy (`startProxy`, ephemeral
// port, real config from `.env`) against the REAL upstream, driven with the
// REAL `openai` SDK client. Runs via `npm run e2e` ONLY (root
// `vitest.e2e.config.ts`); the proxy project's vitest include pins plain
// `npm test` to `test/*.test.ts`, so this directory is never collected there.
//
// `.env` is parsed by hand (no dotenv). When `UPSTREAM_API_KEY` is
// missing/empty, every test below is skipped via `describe.skipIf` after one
// explicit logged skip line, and the run exits 0. The upstream key is used
// only to reach the upstream — never logged, asserted on, or written.
//
// Scenarios (brief order):
//   1. 3-turn conversation — every turn answers; turn 2 is sized to overflow
//      the cap (~9k tokens of varied filler) so the fleet runs live.
//   2. Oversized single-shot (~20k tokens) — valid response, every telemetry
//      `subcall` entry ≤ CAP_TOKENS, planner+worker+synthesizer all present.
//   3. Cache replay — the SAME oversized request twice; the second is a
//      telemetry-marked cache hit and replays the same content.
//   4. Streaming oversized via the SDK's `.stream()` — collects a non-empty
//      assistant message and completes cleanly (the SDK saw `[DONE]`).
//   5. Spawn test — `npm run build`, spawn `node packages/proxy/dist/main.js`
//      on a free port, poll `GET /v1/models` (20s), one chat request.
//   6. tool_calls live best-effort — well-formed tool_calls OR a graceful
//      plain-text answer (nondeterminism is logged honestly).
//
// The deterministic scripted-fake half of the tool_calls requirement lives in
// the normal suite: packages/proxy/test/tool-calls-sdk.test.ts.

import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import OpenAI from "openai";
import { Telemetry, loadConfig, startProxy } from "../../src/index.js";
import type { ProxyConfig } from "../../src/index.js";
import { TokenAccountant, countTokens } from "@context-hierarchy/core";

// packages/proxy/test/e2e → repo root (where .env lives).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Minimal `KEY=VALUE` line parser (same dialect as proxy src/config.ts and
 *  the existing live tests — no dotenv dependency). A missing file reads as
 *  empty, which skips the suite honestly below. */
function parseEnv(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = parseEnv(join(repoRoot, ".env"));
const HAS_UPSTREAM_KEY = Boolean(env.UPSTREAM_API_KEY);
if (!HAS_UPSTREAM_KEY) {
  // Brief R2: one explicit skip line; every test is describe.skipIf'd away and
  // the suite exits 0.
  console.log("E2E SKIPPED: no upstream key in .env");
}

/** Varied filler sentences — rotated with numbered prefixes, so the filler is
 *  many different sentences, never one repeated token. */
const SENTENCES = [
  "The harbor log records every vessel that crossed the breakwater before dawn.",
  "A compiler translates each statement into instructions the machine can execute directly.",
  "Migrating geese navigate by stars and by the faint magnetism of the earth itself.",
  "The recipe calls for slow caramelization until the onions turn deep amber.",
  "Every distributed system must choose between consistency and availability under partition.",
  "The archivist numbered each folder twice to survive the flood inventory of 1962.",
  "Rainfall measured at the ridge station exceeded all seasonal averages again this spring.",
  "A token is a chunk of text small enough for a model to attend to at once.",
  "The apprentice learned to sharpen chisels before being allowed near the walnut.",
  "Cache entries persist content-addressed on disk and never rewrite in place.",
  "Signal crews spliced the cable at midnight while the repeaters hummed in parallel.",
  "Careful truncation preserves the head and the tail of any document it shortens.",
  "The bakery's starter has been fed daily since the original oven was first lit.",
  "Estimates carry a margin because counting exactly always costs more than being safe.",
  "The surveyor sketched the property boundary from the old oak to the iron pin.",
  "Night shift operators log anomalies with timestamps and a short plain summary.",
];

/** Deterministic filler of at least `targetTokens` raw cl100k tokens. */
function filler(targetTokens: number, seed: number): string {
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; total < targetTokens; i++) {
    const sentence = `note ${i}: ${SENTENCES[(i * 7 + seed) % SENTENCES.length]}`;
    parts.push(sentence);
    total += countTokens(sentence);
  }
  return parts.join("\n");
}

/** One telemetry line as a loose record. */
type TelemetryEntry = Record<string, unknown>;

/** A minimal valid completion shape the assertions below need. */
interface CompletionLike {
  model: string;
  choices: Array<{ message: { content: string | null } }>;
}

describe.skipIf(!HAS_UPSTREAM_KEY)("live E2E against the real upstream (npm run e2e)", () => {
  let proxy!: { url: string; close(): Promise<void> };
  let client!: OpenAI;
  let cfg!: ProxyConfig;
  let telemetry!: Telemetry;
  let dataDir!: string;
  let cap!: number;
  let accountant!: TokenAccountant;
  const spawnDirs: string[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ctxh-e2e-"));
    // Real upstream values from `.env`; ephemeral port; isolated state dir so
    // this suite never touches the repo's `.ctxh/`.
    cfg = loadConfig({ port: 0, dataDir });
    cap = cfg.capTokens;
    proxy = await startProxy(cfg);
    client = new OpenAI({
      baseURL: `${proxy.url}/v1`,
      // "sk-test" when no proxy gate is configured; the real gate key when it is.
      apiKey: cfg.proxyApiKey !== "" ? cfg.proxyApiKey : "sk-test",
    });
    telemetry = new Telemetry(join(dataDir, "telemetry.jsonl"));
    accountant = new TokenAccountant({ dataDir });
  });

  afterAll(async () => {
    await proxy.close();
    for (const dir of spawnDirs) rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Telemetry `subcall` entries appended after `marker`. */
  function subcallsSince(marker: number): TelemetryEntry[] {
    const entries = telemetry.entries() as TelemetryEntry[];
    return entries.slice(marker).filter((e) => e.kind === "subcall");
  }

  /** A valid completion: model field present, non-empty assistant content. */
  function expectValidCompletion(completion: CompletionLike): void {
    expect(completion.model).toBeTypeOf("string");
    expect(completion.model.length).toBeGreaterThan(0);
    const content = completion.choices[0].message.content;
    expect(content).toBeTypeOf("string");
    expect((content ?? "").length).toBeGreaterThan(0);
  }

  it("3-turn conversation: every turn answers; the over-cap turn runs the fleet live", async () => {
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];

    const ask = async (userContent: string): Promise<string> => {
      history.push({ role: "user", content: userContent });
      const completion = await client.chat.completions.create({
        model: "context-hierarchy-e2e",
        messages: [...history],
      });
      expectValidCompletion(completion);
      const reply = completion.choices[0].message.content ?? "";
      history.push({ role: "assistant", content: reply });
      return reply;
    };

    // Turn 1 — small, fits the cap.
    await ask("Remember this snippet: const answer = 6 * 7. Reply with just the word: noted.");

    // Turn 2 — the accumulated history plus ~9k tokens of varied filler:
    // sized to overflow the cap so the fleet path runs live.
    const overflow = `Project notes:\n\n${filler(9000, 11)}\n\nKeep these notes in mind. Reply with one short sentence.`;
    const turn2Messages = [...history, { role: "user" as const, content: overflow }];
    expect(accountant.estimate(turn2Messages, cfg.upstreamModel)).toBeGreaterThan(cap);
    const beforeTurn2 = telemetry.entries().length;
    await ask(overflow);

    // Turn 3 — the whole accumulated history (filler included) again.
    const beforeTurn3 = telemetry.entries().length;
    await ask("Based on everything above, give me one concrete next step.");

    // Honest observation for the report, plus the brief's stated purpose of
    // the sizing: at least one fleet sub-call ran live across the over-cap turns.
    const roles2 = subcallsSince(beforeTurn2).map((e) => String(e.call));
    const roles3 = subcallsSince(beforeTurn3).map((e) => String(e.call));
    console.log(`e2e 3-turn: turn-2 subcalls [${roles2.join(", ")}], turn-3 subcalls [${roles3.join(", ")}]`);
    const fleetRan = [...roles2, ...roles3].some((r) => r !== "direct");
    expect(
      fleetRan,
      `expected a fleet sub-call (planner/worker/synthesizer) after the over-cap turns; saw turn-2 [${roles2.join(", ")}], turn-3 [${roles3.join(", ")}]`,
    ).toBe(true);
  });

  it("oversized single-shot (~20k tokens): valid response; every subcall ≤ cap; planner+worker+synthesizer present", async () => {
    // One request (no multi-turn accumulation) whose bulk is a single ~20k
    // token user message. Engine note (fleet-engine.ts): a LONE over-cap user
    // message leaves the middle region empty and the fleet degenerates to one
    // synthesizer call — no planner, no workers. The small assistant ack
    // between the bulk and the final ask keeps the bulk message in the middle
    // region so the full pipeline (which this test asserts on) runs.
    const messages = [
      { role: "user" as const, content: `Analysis notes:\n\n${filler(19_500, 23)}\n\nThose are the notes.` },
      { role: "assistant" as const, content: "I have read the notes." },
      { role: "user" as const, content: "In one sentence: what are these notes about?" },
    ];
    expect(accountant.estimate(messages, cfg.upstreamModel)).toBeGreaterThan(cap);

    const marker = telemetry.entries().length;
    const completion = await client.chat.completions.create({
      model: "context-hierarchy-e2e",
      messages,
    });
    expectValidCompletion(completion);

    const subcalls = subcallsSince(marker);
    expect(subcalls.length).toBeGreaterThan(0);
    for (const event of subcalls) {
      expect(
        event.estimatedTokens,
        `subcall ${event.call} estimated ${event.estimatedTokens} exceeds cap ${cap}`,
      ).toBeLessThanOrEqual(cap);
    }
    const roles = new Set(subcalls.map((e) => String(e.call)));
    expect(roles.has("planner"), `planner subcall missing; saw [${[...roles].join(", ")}]`).toBe(true);
    expect(roles.has("worker"), `worker subcall missing; saw [${[...roles].join(", ")}]`).toBe(true);
    expect(roles.has("synthesizer"), `synthesizer subcall missing; saw [${[...roles].join(", ")}]`).toBe(true);
  });

  it("cache replay: the SAME oversized request twice — both valid, the second a telemetry-marked cache hit", async () => {
    const messages = [
      { role: "user" as const, content: `Field log:\n\n${filler(9000, 37)}` },
      { role: "assistant" as const, content: "Logged. What would you like me to do with it?" },
      { role: "user" as const, content: "In one short sentence, summarize the log." },
    ];
    expect(accountant.estimate(messages, cfg.upstreamModel)).toBeGreaterThan(cap);

    const first = await client.chat.completions.create({ model: "context-hierarchy-e2e", messages });
    expectValidCompletion(first);

    const marker = telemetry.entries().length;
    const second = await client.chat.completions.create({ model: "context-hierarchy-e2e", messages });
    expectValidCompletion(second);

    // The replay serves the cached final verbatim.
    expect(second.choices[0].message.content).toBe(first.choices[0].message.content);
    // And the engine marked the replay in telemetry (cacheHit: true).
    const subcalls = subcallsSince(marker);
    expect(
      subcalls.some((e) => e.cacheHit === true),
      `no cacheHit subcall after the replay; saw ${JSON.stringify(subcalls)}`,
    ).toBe(true);
  });

  it("streaming oversized via the SDK's .stream(): collects a non-empty assistant message and completes cleanly", async () => {
    const messages = [
      { role: "user" as const, content: `Design log:\n\n${filler(8000, 51)}` },
      { role: "assistant" as const, content: "Understood." },
      { role: "user" as const, content: "Write a haiku about keeping logs." },
    ];
    expect(accountant.estimate(messages, cfg.upstreamModel)).toBeGreaterThan(cap);

    const stream = client.chat.completions.stream({
      model: "context-hierarchy-e2e",
      messages,
      stream: true,
    });
    // Resolves only when the stream completed cleanly — the SDK's parser saw
    // the terminal [DONE] (a broken or hanging stream rejects or hangs here).
    const completion = await stream.finalChatCompletion();
    expect(completion.model).toBeTypeOf("string");
    expect(completion.model.length).toBeGreaterThan(0);
    const content = completion.choices[0].message.content;
    expect(content).toBeTypeOf("string");
    expect((content ?? "").length).toBeGreaterThan(0);
    expect(completion.choices[0].finish_reason).toBeTruthy();
  });

  it("spawn test: npm run build, node dist/main.js on a free port, /v1/models up, one chat request 200", async () => {
    // 1) Build both workspaces — the spawned entry point runs from dist.
    //    Single-string command through the shell (portable npm on Windows:
    //    npm is npm.cmd; no args array, so no DEP0190 escaping warning).
    await new Promise<void>((resolve, reject) => {
      const build = spawn("npm run build", { cwd: repoRoot, shell: true });
      let out = "";
      build.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      build.stderr.on("data", (chunk) => {
        out += String(chunk);
      });
      build.on("error", reject);
      build.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`npm run build exited ${code}:\n${out.slice(-2000)}`));
      });
    });

    // 2) Reserve a free port for the child (listen 0, read it, release it).
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const free = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(free));
      });
    });

    const childDataDir = mkdtempSync(join(tmpdir(), "ctxh-e2e-spawn-"));
    spawnDirs.push(childDataDir);

    // 3) Spawn the built proxy with the upstream vars from .env.
    const child = spawn(process.execPath, [join(repoRoot, "packages", "proxy", "dist", "main.js")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        UPSTREAM_BASE_URL: env.UPSTREAM_BASE_URL,
        UPSTREAM_API_KEY: env.UPSTREAM_API_KEY,
        UPSTREAM_MODEL: env.UPSTREAM_MODEL,
        CAP_TOKENS: String(cap),
        DATA_DIR: childDataDir,
        PROXY_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childOut = "";
    child.stdout.on("data", (chunk) => {
      childOut += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      childOut += String(chunk);
    });
    // Exit watcher attached BEFORE the first await, so a child that dies at any
    // point below still resolves it (awaiting it can never hang).
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    try {
      // 4) Poll GET /v1/models until the child is up (timeout 20s).
      const deadline = Date.now() + 20_000;
      let up = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
          if (res.ok) {
            up = true;
            break;
          }
        } catch {
          // not listening yet
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(up, `spawned proxy did not come up within 20s; output:\n${childOut}`).toBe(true);

      // 5) One chat request through the spawned process.
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "context-hierarchy-e2e",
          messages: [{ role: "user", content: "Reply with the single word: pong" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: Array<{ message: { content: string | null } }> };
      expect((body.choices[0].message.content ?? "").length).toBeGreaterThan(0);
    } finally {
      // 6) Kill the child and wait for exit (force after 5s).
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("tool_calls live (best-effort): a well-formed tool_calls response OR a graceful plain-text answer", async () => {
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "get_weather",
          description: "Get the current weather for a given city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];
    const completion = await client.chat.completions.create({
      model: "context-hierarchy-e2e",
      messages: [{ role: "user", content: "What is the weather in Berlin right now? Use the get_weather tool." }],
      tools,
      tool_choice: "auto",
    });

    const message = completion.choices[0].message;
    const toolCalls = message.tool_calls;
    if (toolCalls !== undefined && toolCalls.length > 0) {
      // Well-formed tool_calls: id, type, exact function name, JSON arguments.
      console.log("e2e tool_calls: model emitted tool_calls — asserting they are well-formed");
      const call = toolCalls[0];
      expect(call.id).toBeTypeOf("string");
      expect(call.id.length).toBeGreaterThan(0);
      expect(call.type).toBe("function");
      expect(call.function.name).toBe("get_weather");
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.function.arguments);
      } catch (e) {
        throw new Error(`tool_call arguments are not valid JSON: ${call.function.arguments} (${e})`);
      }
      expect(parsed).toBeTypeOf("object");
      console.log(`e2e tool_calls: well-formed call to ${call.function.name} with arguments ${call.function.arguments}`);
    } else {
      // OR a graceful plain-text answer — log which happened.
      console.log("e2e tool_calls: model answered in plain text (no tool_calls) — asserting a graceful non-empty answer");
      expect(message.content).toBeTypeOf("string");
      expect((message.content ?? "").length).toBeGreaterThan(0);
    }
  });
});
