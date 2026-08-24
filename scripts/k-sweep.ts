/**
 * k-sweep: an experiment comparing how many craft questions a small local
 * coach sees per call. It walks the draft in non-overlapping windows (via
 * planSweep) and, for each window, runs four arms against the SAME 5-seed
 * pool:
 *
 *   control  — one seed alone, the production prompt (byte-identical to
 *              src/reshape.ts buildPrompt)
 *   k3       — three seeds in one numbered prompt
 *   k5       — five seeds in one numbered prompt
 *   bestof3  — three independent one-seed calls; the first gate-pass wins
 *
 * Every model call is gated exactly like src/reshape.ts tryComplete and
 * retried ONCE with the same corrective suffixes. Each call is recorded as
 * one JSONL trial row (data/k-experiment/trials.jsonl) for the reporter to
 * aggregate. The runner itself writes only trials.jsonl + run-meta.json.
 */

import { appendFileSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planSweep } from '../web/coach-sweep.js';
import { copiesSeed, echoesText, isGrounded, isSingleQuestion } from '../src/gate.js';
import { topicProbe } from '../src/topic-probe.js';
import { GENRES, type Genre } from '../src/types.js';
import { loadEnvFile } from '../src/env.js';
import { RESHAPE_SYSTEM, RETRY_SUFFIXES, buildPrompt } from '../src/reshape.js';

const execFileAsync = promisify(execFile);

/** The arms this experiment compares; --arms is filtered to this set. */
const ARMS = ['control', 'k3', 'k5', 'bestof3'] as const;
type Arm = (typeof ARMS)[number];

/** Why a model output failed the gate; selects the corrective nudge. Mirrors src/reshape.ts. */
type GateFailure = 'syntax' | 'ungrounded' | 'echo' | 'seedcopy';

const DRAFT_PATH = 'data/drafts/current.md';
const OUT_DIR = 'data/k-experiment';
const TRIALS_PATH = `${OUT_DIR}/trials.jsonl`;
const META_PATH = `${OUT_DIR}/run-meta.json`;
/** Seeds pulled per window (each window gets its own 5-seed pool). */
const SEED_POOL = 5;

/**
 * Plural seedcopy nudge, used only when the model saw SEVERAL craft questions
 * in one prompt (k3/k5). The singular suffix scolds "the seed's wording" —
 * there is no single seed in a k3/k5 call, so "the seed" becomes "any craft
 * question". This is the one arm-dependent suffix; the other four nudges are
 * seed-agnostic and shared verbatim with reshape.ts.
 */
const SEEDCOPY_PLURAL_SUFFIX =
  "You repeated one of the craft questions almost verbatim. Do not reuse any craft question's wording; write a fresh question about the writer's text.";

function retrySuffix(reason: GateFailure, multi: boolean): string {
  if (multi && reason === 'seedcopy') return SEEDCOPY_PLURAL_SUFFIX;
  return RETRY_SUFFIXES[reason];
}

// buildPrompt is imported from src/reshape.js (S4-12): one source of truth for
// the prompt text; the plural variant below stays experiment-only.

/**
 * The k3/k5 prompt: a numbered craft-question block instead of a single one.
 * Same rules/reminder layout as buildPrompt, minimally adapted — the header
 * and closing reminder name plural CRAFT QUESTIONS, and the intent rule
 * pluralizes. The first seed is listed first, in feed order.
 */
function buildMultiPrompt(questions: string[], textWindow: string): string {
  const list = questions.map((q, idx) => `${idx + 1}. ${q}`).join('\n');
  return `You will reshape ONE craft question to fit the writer's passage.

Craft questions (keep each one's intent):
${list}

Rules:
- Ask ONE question addressed to the writer ("you"), ending in ?
- Anchor it to one specific detail — quote the writer's exact words
- Keep the craft questions' INTENT; use the passage only for that anchor
- If a [CURSOR START] / [CURSOR END] region exists, anchor to a detail inside it when possible

Passage:
${textWindow}

Reminder: ask ONE question that keeps THE CRAFT QUESTIONS' INTENT above,
anchored to a quoted detail from the PASSAGE above.`;
}

/** The gate, in the exact order of src/reshape.ts tryComplete. */
type GateResult = { ok: true } | { ok: false; reason: GateFailure };
function gate(question: string, textWindow: string, fedJoined: string): GateResult {
  if (!isSingleQuestion(question)) return { ok: false, reason: 'syntax' };
  if (!isGrounded(question, textWindow)) return { ok: false, reason: 'ungrounded' };
  if (echoesText(question, textWindow)) return { ok: false, reason: 'echo' };
  if (copiesSeed(question, fedJoined)) return { ok: false, reason: 'seedcopy' };
  return { ok: true };
}

/** A coach call that failed (network / non-200 / missing content) carries its latency. */
class CoachError extends Error {
  constructor(message: string, readonly latMs: number) {
    super(message);
  }
}

/**
 * One raw completion. Temperature is deliberately OMITTED so the server's
 * default applies — production parity with the coach endpoint. Returns the
 * trimmed assistant text plus the first-attempt fetch latency. Endpoint and
 * model are read from the env at call time (after loadEnvFile has populated
 * them), not at module load.
 */
async function coach(system: string, userText: string): Promise<{ content: string; latMs: number }> {
  const base = (process.env.BW_LLM_BASE_URL ?? 'http://127.0.0.1:8088/v1').replace(/\/+$/, '');
  const model = process.env.BW_LLM_MODEL ?? 'bonsai-27b';
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userText },
        ],
      }),
    });
  } catch (err) {
    throw new CoachError(`coach fetch failed: ${err instanceof Error ? err.message : String(err)}`, Date.now() - started);
  }
  const latMs = Date.now() - started;
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 300);
    throw new CoachError(`coach call failed (HTTP ${res.status}): ${snippet}`, latMs);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new CoachError('coach call returned no text content', latMs);
  }
  return { content: content.trim(), latMs };
}

/** The outcome of one gate-passed/retried/topic-probe trial (one rep of one arm). */
interface RepResult {
  /** raw trimmed first-attempt output (empty when the model call failed) */
  output: string;
  /** first-attempt gate result */
  gate: GateResult;
  /** what /ask would return: passed question | retry question | topic probe */
  final: string;
  /** true iff the first attempt failed and a corrective retry was made */
  retried: boolean;
  /** true iff both attempts failed and final is the topic probe */
  topicProbe: boolean;
  /** first-attempt completion latency (ms) */
  latMs: number;
}

/**
 * One trial: a single completion attempt, gated; on failure, ONE corrective
 * retry; if that also fails, the topic-probe fallback. Mirrors src/reshape.ts
 * reshape/tryComplete, parameterized by how many seeds were fed (multi) for
 * the copiesSeed check and the plural seedcopy nudge.
 */
async function runRep(prompt: string, textWindow: string, fedJoined: string, multi: boolean): Promise<RepResult> {
  let first: { content: string; latMs: number };
  try {
    first = await coach(RESHAPE_SYSTEM, prompt);
  } catch (err) {
    // A thrown model call is treated as a gate failure, exactly as
    // reshape.ts tryComplete does (its catch returns reason 'syntax').
    first = { content: '', latMs: err instanceof CoachError ? err.latMs : 0 };
  }
  const output = first.content;
  const firstGate = gate(output, textWindow, fedJoined);
  if (firstGate.ok) {
    return { output, gate: firstGate, final: output, retried: false, topicProbe: false, latMs: first.latMs };
  }

  let retryOut = '';
  try {
    retryOut = (await coach(RESHAPE_SYSTEM, `${prompt}\n\n${retrySuffix(firstGate.reason, multi)}`)).content;
  } catch {
    retryOut = '';
  }
  const retryGate = gate(retryOut, textWindow, fedJoined);
  if (retryGate.ok) {
    return { output, gate: firstGate, final: retryOut, retried: true, topicProbe: false, latMs: first.latMs };
  }
  return {
    output,
    gate: firstGate,
    final: topicProbe(textWindow),
    retried: true,
    topicProbe: true,
    latMs: first.latMs,
  };
}

/** One JSONL trial record — schema shared with the reporter (verbatim contract). */
interface TrialRecord {
  window: number; // 0-based plan index
  arm: Arm;
  rep: number; // repetition index within window+arm
  seed_ids: string[]; // ids of seeds FED to the model (bestof3: the one id used)
  prompt: string; // exact full user-prompt text sent to the model (first attempt)
  output: string; // raw trimmed first-attempt model output
  gate: { ok: boolean; reason?: GateFailure };
  final: string; // what /ask would return: passed question | retry question | topic probe
  retried: boolean;
  topic_probe: boolean;
  lat_ms: number; // first-attempt completion latency
}

interface RunMeta {
  started: string;
  draftWords: number;
  windowsTotal: number;
  arms: Arm[];
  repsPerArm: number;
  seedPoolByWindow: number;
}

interface Options {
  windows: number;
  reps: number;
  genre: Genre;
  arms: Arm[];
  dryRun: boolean;
  append: boolean;
}

/** Parse the CLI; --arms is a comma list filtered to the four valid arms (order preserved, deduped). */
function parseArgs(argv: string[]): Options {
  const opts: Options = {
    windows: 10,
    reps: 3,
    genre: 'essay',
    arms: [...ARMS],
    dryRun: false,
    append: false,
  };
  const intFlag = (value: string | undefined, name: string): number => {
    const n = Number.parseInt(value ?? '', 10);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`--${name} expects a non-negative integer, got: ${JSON.stringify(value)}`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`--${arg.replace(/^--/, '')} expects a value`);
      i++;
      return v;
    };
    switch (arg) {
      case '--windows':
        opts.windows = intFlag(next(), 'windows');
        break;
      case '--reps':
        opts.reps = intFlag(next(), 'reps');
        break;
      case '--genre': {
        const g = next();
        if (!(GENRES as readonly string[]).includes(g)) {
          throw new Error(`--genre must be one of: ${GENRES.join(', ')} (got ${JSON.stringify(g)})`);
        }
        opts.genre = g as Genre;
        break;
      }
      case '--arms': {
        const requested = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const filtered = [...new Set(requested.filter((a): a is Arm => (ARMS as readonly string[]).includes(a)))];
        if (filtered.length === 0) {
          throw new Error(`--arms must include at least one of: ${ARMS.join(', ')}`);
        }
        opts.arms = filtered;
        break;
      }
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--append':
        opts.append = true;
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return opts;
}

/** Side-effect-free plan matrix for --dry-run (no model calls, no seed pulls). */
function printPlan(opts: Options, draftWindows: number): void {
  console.log('k-sweep dry-run (no model calls, no seed pulls)');
  console.log(`windowsTotal: ${opts.windows} (draft yields ${draftWindows})`);
  console.log(`repsPerArm: ${opts.reps}`);
  console.log(`genre: ${opts.genre}`);
  console.log(`seedPoolByWindow: ${SEED_POOL} (one retrieve.py pull per window, 5 seeds each)`);
  console.log('arms (seed-count per call):');
  for (const arm of opts.arms) {
    const desc =
      arm === 'control'
        ? '1 seed, production prompt, reps calls/window'
        : arm === 'k3'
          ? '3 seeds, one numbered prompt, reps calls/window'
          : arm === 'k5'
            ? '5 seeds, one numbered prompt, reps calls/window'
            : '3 independent 1-seed calls/window (first gate-pass wins)';
    console.log(`  ${arm}: ${desc}`);
  }
}

async function pullSeeds(genre: Genre, n: number): Promise<{ id: string; question: string }[]> {
  const { stdout } = await execFileAsync(
    'python3',
    ['seeds/retrieve.py', 'pull', '--genre', genre, '--n', String(n)],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, cwd: process.cwd() },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`seed pull returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('seed pull returned non-array JSON');
  const arr = parsed as unknown[];
  return arr.map((raw) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('seed pull returned a malformed seed');
    const rec = raw as Record<string, unknown>;
    if (typeof rec.id !== 'string' || typeof rec.question !== 'string') {
      throw new Error('seed pull returned a malformed seed (missing id/question)');
    }
    return { id: rec.id, question: rec.question };
  });
}

function appendTrial(rec: TrialRecord): void {
  appendFileSync(TRIALS_PATH, `${JSON.stringify(rec)}\n`, 'utf8');
}

function writeMeta(meta: RunMeta): void {
  writeFileSync(META_PATH, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  loadEnvFile(); // like server.ts: populate BW_LLM_* from .env before any coach call

  const draft = readFileSync(DRAFT_PATH, 'utf8');
  const plan = planSweep(draft);

  if (opts.dryRun) {
    printPlan(opts, plan.length);
    return; // no files touched, no model calls, no seed pulls
  }

  const windowsTotal = Math.min(opts.windows, plan.length);
  const draftWords = draft.split(/\s+/).filter((w) => w.length > 0).length;

  mkdirSync(OUT_DIR, { recursive: true });
  // Append mode accumulates across reruns; otherwise truncate at start.
  // writeFileSync('') both creates a missing file and empties an existing one.
  if (!opts.append) writeFileSync(TRIALS_PATH, '', 'utf8');
  writeMeta({
    started: new Date().toISOString(),
    draftWords,
    windowsTotal,
    arms: opts.arms,
    repsPerArm: opts.reps,
    seedPoolByWindow: SEED_POOL,
  });

  for (let i = 0; i < windowsTotal; i++) {
    const win = plan[i];
    // One fresh 5-seed pool per window, shared by every arm in this window.
    const seeds = await pullSeeds(opts.genre, SEED_POOL);

    const passCounts: Partial<Record<Arm, { pass: number; total: number }>> = {};
    for (const arm of opts.arms) passCounts[arm] = { pass: 0, total: 0 };

    /** Append a trial row and tally its gate-pass for the progress line. */
    const record = (rec: TrialRecord): void => {
      appendTrial(rec);
      const tally = passCounts[rec.arm];
      if (tally) {
        tally.total++;
        if (rec.final !== '' && !rec.topic_probe) tally.pass++;
      }
    };

    // control / k3 / k5: one call per rep, all sharing the pool.
    for (const arm of opts.arms) {
      if (arm === 'bestof3') continue;
      const count = arm === 'control' ? 1 : arm === 'k3' ? 3 : 5;
      const fed = seeds.slice(0, count);
      const fedJoined = fed.map((s) => s.question).join('\n');
      const multi = arm !== 'control';
      for (let r = 0; r < opts.reps; r++) {
        const prompt =
          arm === 'control'
            ? buildPrompt(fed[0].question, win.markedText)
            : buildMultiPrompt(fed.map((s) => s.question), win.markedText);
        const res = await runRep(prompt, win.markedText, fedJoined, multi);
        record({
          window: i,
          arm,
          rep: r,
          seed_ids: fed.map((s) => s.id),
          prompt,
          output: res.output,
          gate: res.gate,
          final: res.final,
          retried: res.retried,
          topic_probe: res.topicProbe,
          lat_ms: res.latMs,
        });
      }
    }

    // bestof3: three INDEPENDENT one-seed calls with the control prompt;
    // the first gate-pass wins and ends the arm for this window. Each sub-call
    // is its own trial row; only the winning row carries a non-empty final.
    if (opts.arms.includes('bestof3')) {
      for (let j = 0; j < 3; j++) {
        const seed = seeds[j];
        const prompt = buildPrompt(seed.question, win.markedText);
        const res = await runRep(prompt, win.markedText, seed.question, false);
        const won = !res.topicProbe; // final is a passed/retry question, not the probe
        let final = '';
        let topicProbeFlag = false;
        if (won) {
          final = res.final;
        } else if (j === 2) {
          // Budget exhausted with no gate-pass: the last sub-call row carries
          // the topic-probe fallback; the earlier losing rows keep final=''.
          final = res.final;
          topicProbeFlag = true;
        }
        record({
          window: i,
          arm: 'bestof3',
          rep: j,
          seed_ids: [seed.id],
          prompt,
          output: res.output,
          gate: res.gate,
          final,
          retried: res.retried,
          topic_probe: topicProbeFlag,
          lat_ms: res.latMs,
        });
        if (won) break; // first gate-pass wins
      }
    }

    const parts = opts.arms
      .map((a) => {
        const t = passCounts[a];
        return t ? `${a} ${t.pass}/${t.total}` : `${a} -/-`;
      })
      .join(' ');
    console.log(`window ${i}/${windowsTotal} done (pass rates: ${parts})`);
  }

  console.log(
    `k-sweep done: ${windowsTotal} windows, arms [${opts.arms.join(', ')}], reps ${opts.reps}, genre ${opts.genre}`,
  );
}

main().catch((err) => {
  console.error(`k-sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
