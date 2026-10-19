// Synthetic contamination-proof suite (12 tasks). Every entity is INVENTED:
// vessel names are built from syllable tables, codes are drawn from
// per-haystack unique pools, and the setting ("Ore Relay Terminal 9") is
// fictional — nothing here appears on the internet, so no model can have
// memorized the answers.
//
// Ground truths are DERIVED PROGRAMMATICALLY, never hand-typed:
//   needle   — the answer IS the code the generator planted (unique pool);
//   multihop — the sector from the second planted fact, joinable only via
//              the vessel id shared by both facts;
//   update   — the revised value from the later planted statement;
//   count    — a counter incremented while planting the flagged entries.
//
// Haystacks: filler log lines pad to chars ~ 4x target tokens; needles are
// spliced in at LCG-chosen depths (multihop/update facts deliberately far
// apart) and every line is stamped with a deterministic, monotonically
// increasing timestamp (computed arithmetically — no clock reads).

import type { BenchmarkTask, TaskVerify } from "./types.js";
import { Lcg } from "./rng.js";

const BASE_SEED = 0x5eed2026;

// ---------------------------------------------------------------------------
// Fictional vocabulary (invented; checked against the suite test blocklist).
// ---------------------------------------------------------------------------

const SYL_A = [
  "ORT", "VEL", "QUIL", "BRAX", "NEX", "TARB",
  "GAV", "KRIV", "SOLT", "ZELP", "FEND", "TRIM",
] as const;
const SYL_B = [
  "UNDA", "MARA", "TESS", "OX", "IEL", "AND",
  "UV", "ESS", "OPIR", "ALM", "INT", "URA",
] as const;
/** Two-letter stems for sector/zone codes (e.g. "KR-2", "TL-4"). */
const PAIR = [
  "KR", "TL", "QX", "ZV", "NM", "XT", "KQ", "LZ",
  "VR", "MQ", "RK", "WJ", "YB", "PD", "BN", "XD", "FJ",
] as const;
/** Three-letter stems for cargo manifest codes (e.g. "MKL-33"). */
const TRIPLE = ["MKL", "TVR", "QSD", "ZBN", "XFR", "PLW", "KRD", "VJT", "QLM", "XBZ"] as const;
/** Fictional equipment parameters whose value gets revised mid-log. */
const PARAMS = [
  "ballast pump duty code",
  "tug rotation override code",
  "crane lock threshold code",
  "desalination cycle stamp",
  "beacon sync offset code",
  "ferry trim limit code",
] as const;

const SYSTEM =
  "You are a meticulous port-operations log analyst. " +
  "Use only the log excerpt provided. " +
  "When asked for a code or a number, answer with that value only.";

/** Target token estimate for synthetic task `n` within a category (n=1,2,3). */
function tierTokens(n: number): number {
  return n === 1 ? 3000 : n === 2 ? 8000 : 15000;
}

// ---------------------------------------------------------------------------
// Per-haystack generation context.
// ---------------------------------------------------------------------------

interface Ctx {
  rng: Lcg;
  fleet: string[];
  /** Vessel name from the fleet (may repeat across lines — realistic). */
  vessel: () => string;
  /** Unique cargo manifest code, e.g. "MKL-33" (never repeats here). */
  cargo: () => string;
  /** Unique certification code, e.g. "XQ-4471". */
  cert: () => string;
  /** Unique 2-letter + 1-digit sector/zone code, e.g. "TL-4". */
  zone: () => string;
  /** Unique 2-letter + 2-digit value code, e.g. "RQ-71". */
  valueCode: () => string;
}

function makeCtx(rng: Lcg): Ctx {
  const used = new Set<string>();
  const unique = (draw: () => string): string => {
    let code = draw();
    while (used.has(code)) code = draw();
    used.add(code);
    return code;
  };
  const fleet: string[] = [];
  while (fleet.length < 30) {
    const name = `${rng.pick(SYL_A)}${rng.pick(SYL_B)}-${1 + rng.int(9)}`;
    if (!fleet.includes(name)) fleet.push(name);
  }
  return {
    rng,
    fleet,
    vessel: () => rng.pick(fleet),
    cargo: () => unique(() => `${rng.pick(TRIPLE)}-${rng.between(10, 99)}`),
    cert: () => unique(() => `${rng.pick(PAIR)}-${rng.between(1000, 9999)}`),
    zone: () => unique(() => `${rng.pick(PAIR)}-${1 + rng.int(9)}`),
    valueCode: () => unique(() => `${rng.pick(PAIR)}-${rng.between(10, 99)}`),
  };
}

// ---------------------------------------------------------------------------
// Filler log lines (fictional telemetry; never contain needle-shaped codes
// beyond the pooled cargo manifests, which cannot collide with planted facts).
// ---------------------------------------------------------------------------

function commonFiller(ctx: Ctx): Array<() => string> {
  const { rng } = ctx;
  return [
    () =>
      `Vessel ${ctx.vessel()} telemetry: hull stress 0.${rng.between(10, 97)}, ` +
      `drift ${rng.between(0, 3)}.${rng.between(0, 9)} kn, heading ${rng.between(0, 359)}`,
    () =>
      `Vessel ${ctx.vessel()} holding at waypoint ${rng.between(1, 480)}, ` +
      `drafts F${rng.between(4, 9)}.${rng.between(0, 9)} m / A${rng.between(5, 10)}.${rng.between(0, 9)} m`,
    () =>
      `cargo manifest ${ctx.cargo()} loaded: ${rng.between(2, 30)} crates, ` +
      `${rng.between(1, 24)}.${rng.between(0, 9)} t, seal intact`,
    () => `cargo manifest ${ctx.cargo()} transferred to shed ${rng.between(1, 12)}, tally verified`,
    () =>
      `weather buoy ${rng.between(10, 99)}: swell ${rng.between(0, 4)} m, ` +
      `wind ${rng.between(0, 40)} kn, visibility ${rng.between(1, 9)} nm`,
    () => `pump ${rng.between(1, 24)} vibration nominal, bearing temp ${rng.between(30, 80)} C`,
    () => `crane ${rng.between(1, 6)} cable tension re-checked, log signed by duty officer`,
    () => `Vessel ${ctx.vessel()} crew rotation complete, ${rng.between(4, 22)} hands aboard`,
  ];
}

/** Zone-themed filler used only by count-aggregate tasks. */
function zoneFiller(ctx: Ctx, zone: string, otherZones: string[]): Array<() => string> {
  const { rng } = ctx;
  return [
    // Decoy: same zone, but NOT flagged.
    () => `Vessel ${ctx.vessel()} passed routine inspection in zone ${zone}`,
    // Decoy: flagged, but a different zone.
    () => `Vessel ${ctx.vessel()} flagged for inspection in zone ${rng.pick(otherZones)}`,
    () => `zone ${zone} perimeter sweep complete, ${rng.between(0, 3)} anomalies noted`,
    () => `zone ${rng.pick(otherZones)} gate camera replay archived`,
  ];
}

// ---------------------------------------------------------------------------
// Haystack assembly: pad with filler, splice planted lines in at chosen
// depths, then stamp every line with a deterministic timestamp.
// ---------------------------------------------------------------------------

interface Planted {
  body: string;
  /** Position as a fraction of the filler line count, in [0, 1]. */
  at: number;
}

/** "2026-10-DDThh:mmZ" computed arithmetically from minutes (no clock reads). */
function stamp(minute: number): string {
  const day = 14 + Math.floor(minute / 1440);
  const rest = minute % 1440;
  const hh = String(Math.floor(rest / 60)).padStart(2, "0");
  const mm = String(rest % 60).padStart(2, "0");
  return `2026-10-${String(day).padStart(2, "0")}T${hh}:${mm}Z`;
}

/** Fixed stamp width "[2026-10-14T06:12Z] " — same for every line. */
const STAMP_CHARS = 20;

function buildLog(
  rng: Lcg,
  targetChars: number,
  planted: Planted[],
  filler: () => string,
): { text: string; plantedLines: string[] } {
  const header =
    "OPERATIONS LOG EXCERPT - ORE RELAY TERMINAL 9\n" +
    "Automated export; entries are in chronological order.";
  const bodies: Array<{ body: string; plant?: number }> = [];
  // Count the final rendered length (stamp + body + newline) so the log
  // actually lands near targetChars.
  let chars = header.length;
  while (chars < targetChars) {
    const body = filler();
    bodies.push({ body });
    chars += STAMP_CHARS + body.length + 1;
  }
  // Splice in descending position so earlier insert indices stay valid.
  const ordered = planted
    .map((p, i) => ({ ...p, i }))
    .sort((x, y) => y.at - x.at);
  for (const p of ordered) {
    const idx = Math.min(bodies.length, Math.round(p.at * bodies.length));
    bodies.splice(idx, 0, { body: p.body, plant: p.i });
  }
  const lines: string[] = [];
  const plantedLines: string[] = [];
  let minute = rng.between(0, 240);
  for (const entry of bodies) {
    minute += rng.between(1, 6);
    const line = `[${stamp(minute)}] ${entry.body}`;
    lines.push(line);
    if (entry.plant !== undefined) {
      plantedLines[entry.plant] = line;
    }
  }
  if (plantedLines.some((l) => l === undefined)) {
    throw new Error("buildLog: a planted line was not stamped");
  }
  return { text: `${header}\n${lines.join("\n")}`, plantedLines };
}

/** Assembles the pinned 3-message shape (system + haystack + question) and
 *  derives haystackTokens from actual content at ~4 chars/token. */
function assemble(
  id: string,
  logText: string,
  question: string,
  verify: TaskVerify,
  notes: string,
): BenchmarkTask {
  const messages: BenchmarkTask["messages"] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: logText },
    { role: "user", content: question },
  ];
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return { id, kind: "synthetic", haystackTokens: Math.round(chars / 4), messages, verify, notes };
}

// ---------------------------------------------------------------------------
// Category builders.
// ---------------------------------------------------------------------------

function needleTask(n: number, tokens: number): { task: BenchmarkTask; grounding: string[] } {
  const rng = new Lcg(BASE_SEED + 0x11 * n);
  const ctx = makeCtx(rng);
  const ship = ctx.vessel();
  const code = ctx.cert();
  const at = 0.15 + 0.7 * rng.fraction();
  const makers = commonFiller(ctx);
  const { text, plantedLines } = buildLog(
    rng,
    tokens * 4,
    [{ body: `Vessel ${ship}'s certification code is ${code}.`, at }],
    () => rng.pick(makers)(),
  );
  return {
    task: assemble(
      `synth-needle-${n}`,
      text,
      `What is the certification code of vessel ${ship}? Answer with the code only.`,
      { type: "contains", expected: code },
      `Single needle: the certification code is planted once (unique-code pool ` +
        `guarantees exactly one occurrence) at ${Math.round(at * 100)}% depth. ` +
        `Ground truth is the planted code itself; verify is contains so a ` +
        `correct retrieval survives minor answer punctuation.`,
    ),
    grounding: [plantedLines[0] as string],
  };
}

function multihopTask(n: number, tokens: number): { task: BenchmarkTask; grounding: string[] } {
  const rng = new Lcg(BASE_SEED + 0x22 * n + 7);
  const ctx = makeCtx(rng);
  const cargoId = ctx.cargo();
  const ship = ctx.vessel();
  const sector = ctx.zone();
  const atA = 0.1 + 0.2 * rng.fraction();
  const atB = 0.65 + 0.25 * rng.fraction();
  const makers = commonFiller(ctx);
  const { text, plantedLines } = buildLog(
    rng,
    tokens * 4,
    [
      { body: `Cargo manifest ${cargoId} is loaded onto vessel ${ship}.`, at: atA },
      { body: `Vessel ${ship} is scheduled to dock at sector ${sector}.`, at: atB },
    ],
    () => rng.pick(makers)(),
  );
  return {
    task: assemble(
      `synth-multihop-${n}`,
      text,
      `Which sector does the vessel carrying cargo manifest ${cargoId} dock at? Answer with the sector code only.`,
      { type: "contains", expected: sector },
      `Two-fact join: cargo->vessel entry at ${Math.round(atA * 100)}% depth, ` +
        `vessel->sector entry at ${Math.round(atB * 100)}% depth. No single entry ` +
        `links cargo to sector; the sector code appears exactly once (unique pool, ` +
        `zone-free filler), and the asked cargo id appears exactly once.`,
    ),
    grounding: [plantedLines[0] as string, plantedLines[1] as string],
  };
}

function updateTask(n: number, tokens: number): { task: BenchmarkTask; grounding: string[] } {
  const rng = new Lcg(BASE_SEED + 0x33 * n + 3);
  const ctx = makeCtx(rng);
  const param = rng.pick(PARAMS);
  const original = ctx.valueCode();
  const revised = ctx.valueCode();
  const atOrig = 0.08 + 0.17 * rng.fraction();
  const atRev = 0.7 + 0.22 * rng.fraction();
  const makers = commonFiller(ctx);
  const { text, plantedLines } = buildLog(
    rng,
    tokens * 4,
    [
      { body: `Commissioning record: the ${param} was originally set to ${original}.`, at: atOrig },
      { body: `NOTICE: the ${param} has been revised; the current value is ${revised}.`, at: atRev },
    ],
    () => rng.pick(makers)(),
  );
  return {
    task: assemble(
      `synth-update-${n}`,
      text,
      `What is the CURRENT value of the ${param}? Answer with the current code only.`,
      { type: "contains", expected: revised },
      `Update-tracking: the commissioning value appears at ` +
        `${Math.round(atOrig * 100)}% depth, the revision at ` +
        `${Math.round(atRev * 100)}% depth. The answer is the revised value; ` +
        `the stale commissioning value is the trap for strategies that lose ` +
        `either end of the context.`,
    ),
    grounding: [plantedLines[0] as string, plantedLines[1] as string],
  };
}

function countTask(n: number, tokens: number): { task: BenchmarkTask; grounding: string[] } {
  const rng = new Lcg(BASE_SEED + 0x44 * n + 13);
  const ctx = makeCtx(rng);
  const zone = ctx.zone();
  const otherZones = Array.from({ length: 2 + rng.int(3) }, () => ctx.zone());
  const flaggedFleet = new Set<string>();
  const flaggedVessel = (): string => {
    let name = ctx.vessel();
    while (flaggedFleet.has(name)) name = ctx.vessel();
    flaggedFleet.add(name);
    return name;
  };
  // Ground truth: the planting counter itself (all vessels distinct, so
  // "how many vessels" == "how many flagged entries" in the target zone).
  const target = 10 + rng.int(n === 1 ? 7 : n === 2 ? 11 : 17);
  let count = 0;
  const planted: Planted[] = [];
  while (count < target) {
    planted.push({
      body: `Vessel ${flaggedVessel()} flagged for inspection in zone ${zone}.`,
      at: 0.05 + 0.9 * rng.fraction(),
    });
    count += 1;
  }
  // Guaranteed decoys (planted, never RNG-skipped): a routine pass in the
  // asked zone and a flagged entry in a different zone.
  planted.push({
    body: `Vessel ${ctx.vessel()} passed routine inspection in zone ${zone}.`,
    at: 0.05 + 0.9 * rng.fraction(),
  });
  planted.push({
    body: `Vessel ${ctx.vessel()} flagged for inspection in zone ${otherZones[0]!}.`,
    at: 0.05 + 0.9 * rng.fraction(),
  });
  const makers = [...commonFiller(ctx), ...zoneFiller(ctx, zone, otherZones)];
  const { text } = buildLog(rng, tokens * 4, planted, () => rng.pick(makers)());
  return {
    task: assemble(
      `synth-count-${n}`,
      text,
      `How many vessels were flagged for inspection in zone ${zone} across the log? Answer with the number only.`,
      { type: "numeric", expected: String(count) },
      `Count-aggregate: ground truth is the generator's planting counter; ` +
        `planted entries use distinct vessel names. Decoys: routine-pass ` +
        `entries in the same zone and flagged entries in other zones.`,
    ),
    grounding: [],
  };
}

// ---------------------------------------------------------------------------
// Suite assembly: 4 categories x 3 tasks, each cycling 3k/8k/15k token tiers.
// ---------------------------------------------------------------------------

export function buildSyntheticTasks(): {
  tasks: BenchmarkTask[];
  groundings: Record<string, string[]>;
} {
  const tasks: BenchmarkTask[] = [];
  const groundings: Record<string, string[]> = {};
  const add = (built: { task: BenchmarkTask; grounding: string[] }): void => {
    tasks.push(built.task);
    groundings[built.task.id] = built.grounding;
  };
  for (let n = 1; n <= 3; n++) add(needleTask(n, tierTokens(n)));
  for (let n = 1; n <= 3; n++) add(multihopTask(n, tierTokens(n)));
  for (let n = 1; n <= 3; n++) add(updateTask(n, tierTokens(n)));
  for (let n = 1; n <= 3; n++) add(countTask(n, tierTokens(n)));
  return { tasks, groundings };
}
