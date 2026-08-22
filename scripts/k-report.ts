/**
 * k-report: turn a k-experiment trials log into metrics + a grading sheet.
 *
 * Reads data/k-experiment/trials.jsonl (one JSON object per line — see the
 * k-experiment contract) and emits two artifacts:
 *   - data/k-experiment/metrics.json  — per-arm pass/latency/grounding stats,
 *                                       seed-survival, latency deltas
 *   - data/k-experiment/report.html   — a static, no-asset grading sheet: per
 *                                       window the arm outputs are shuffled and
 *                                       labeled A/B/C/D (seeded from the window
 *                                       number so the order is stable across
 *                                       runs), with radios + notes + verdicts
 *                                       copy/autosave.
 *
 * Pure TS DOM-string building on purpose: no framework, no DOM at runtime —
 * the grading page is assembled as a string and only ever opened by a human.
 *
 * Run: tsx scripts/k-report.ts [trialsPath]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** The four experimental arms, in a fixed display order. */
type Arm = 'control' | 'k3' | 'k5' | 'bestof3';
const ARMS: readonly Arm[] = ['control', 'k3', 'k5', 'bestof3'];

/** A single trial, per the k-experiment contract (verbatim shape). */
interface Trial {
  window: number;
  arm: Arm;
  rep: number;
  seed_ids: string[];
  prompt: string;
  output: string;
  gate: { ok: boolean; reason?: 'syntax' | 'ungrounded' | 'echo' | 'seedcopy' };
  final: string;
  retried: boolean;
  topic_probe: boolean;
  lat_ms: number;
}

type GateReason = NonNullable<Trial['gate']['reason']>;
const GATE_REASONS: readonly GateReason[] = ['syntax', 'ungrounded', 'echo', 'seedcopy'];

/**
 * Words that carry no topical content. A token in this table can never anchor
 * a grounding match, an echo, or a seed copy.
 */
// inlined from src/gate.ts STOPWORDS
const STOPWORDS: Record<string, true> = {
 the: true, a: true, an: true, and: true, or: true, but: true, of: true,
 in: true, on: true, at: true, to: true, for: true, with: true, from: true,
 by: true, as: true, is: true, are: true, was: true, were: true, be: true,
 been: true, being: true, this: true, that: true, these: true, those: true,
 it: true, its: true, your: true, you: true, my: true, i: true, me: true,
 we: true, our: true, they: true, their: true, he: true, she: true,
 him: true, her: true, his: true, them: true, if: true, so: true, such: true,
 not: true, no: true, yes: true, do: true, does: true, did: true,
 have: true, has: true, had: true, will: true, would: true, can: true,
 could: true, should: true, may: true, might: true, must: true, about: true,
 into: true, over: true, under: true, again: true, then: true, once: true,
 here: true, there: true, when: true, where: true, why: true, how: true,
 what: true, who: true, which: true, while: true, after: true, before: true,
 until: true, because: true, than: true, too: true, very: true, just: true,
 also: true, only: true, own: true, same: true, other: true, said: true,
 say: true, says: true, out: true, up: true, down: true, off: true,
 through: true, all: true, any: true, each: true, more: true, most: true,
 some: true, few: true, both: true, between: true, among: true,
 without: true, within: true, across: true, behind: true, beyond: true,
 above: true, below: true, near: true, far: true, long: true, short: true,
 much: true, many: true,
};

/**
 * Lowercase alphanumeric tokens of length >= 3 that are not stopwords.
 * Mirrors src/gate.ts contentWords() so the reporter's continuous grounding
 * metric speaks the same language as the gate's binary decision.
 */
function contentWords(s: string): Set<string> {
 const words = new Set<string>();
 for (const token of s.toLowerCase().split(/[^a-z0-9]+/)) {
  if (token.length < 3) continue;
  if (STOPWORDS[token] === true) continue;
  words.add(token);
 }
 return words;
}

/**
 * Continuous grounding: the fraction of the question's content words that
 * appear in the window text via a bidirectional substring match of min length
 * 4 — the same matching rule isGrounded uses, but reported as a 0..1 fraction
 * instead of a binary verdict. Returns null when either side has no content
 * words (nothing to measure).
 */
function groundingOverlap(question: string, windowText: string): number | null {
 const q = contentWords(question);
 const w = contentWords(windowText);
 if (q.size === 0 || w.size === 0) return null;
 let present = 0;
 for (const qw of q) {
  for (const ww of w) {
   if (Math.min(qw.length, ww.length) < 4) continue;
   if (qw.includes(ww) || ww.includes(qw)) {
    present += 1;
    break;
   }
  }
 }
 return present / q.size;
}

/**
 * Recover the writer's window text from the prompt without dragging in DOM or
 * server dependencies. The passage sits verbatim between '\nPassage:\n' and
 * '\n\nReminder:' (see src/reshape.ts buildPrompt); slice it out. Returns null
 * when either marker is absent — such trials are skipped, not guessed.
 */
function windowTextFromPrompt(prompt: string): string | null {
 const START = '\nPassage:\n';
 const END = '\n\nReminder:';
 const s = prompt.indexOf(START);
 if (s === -1) return null;
 const begin = s + START.length;
 const e = prompt.indexOf(END, begin);
 if (e === -1) return null;
 return prompt.slice(begin, e);
}

/** Deterministic PRNG so per-window shuffles are stable across runs. */
function mulberry32(seed: number): () => number {
 let a = seed >>> 0;
 return () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
 };
}

/** Fisher-Yates shuffle with a seeded PRNG; returns a new array. */
function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
 const rng = mulberry32(seed);
 const out = [...arr];
 for (let i = out.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [out[i], out[j]] = [out[j], out[i]];
 }
 return out;
}

function median(xs: number[]): number | null {
 if (xs.length === 0) return null;
 const sorted = [...xs].sort((a, b) => a - b);
 const mid = Math.floor(sorted.length / 2);
 return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(n: number | null, digits = 3): number | null {
 return n === null ? null : Number(n.toFixed(digits));
}

/** Per-arm summary, keyed by arm. */
interface ArmMetrics {
 attempts: number;
 passRateFirst: number;
 passRateAfterRetry: number;
 topicProbeRate: number;
 medianLatMs: number | null;
 echoCount: number;
 ungroundedCount: number;
 syntaxCount: number;
 seedcopyCount: number;
 grounding: number[]; // per-trial continuous overlap (trials with a window)
 meanGrounding: number | null;
}

function emptyArm(): ArmMetrics {
 return {
  attempts: 0,
  passRateFirst: 0,
  passRateAfterRetry: 0,
  topicProbeRate: 0,
  medianLatMs: null,
  echoCount: 0,
  ungroundedCount: 0,
  syntaxCount: 0,
  seedcopyCount: 0,
  grounding: [],
  meanGrounding: null,
 };
}

/** One grading unit: the arm's representative final question for a window. */
interface GradingCard {
 arm: Arm;
 rep: number;
 question: string;
 overlap: number | null;
 label: string; // 'A'..'D' after the deterministic shuffle
}

interface WindowSheet {
 window: number;
 /** The marked window passage the model saw; rendered so the grader can read the source. */
 windowText: string;
 cards: GradingCard[];
 key: string; // "A=arm:rep, B=arm:rep, ..." for the HTML comment
}

function main(): void {
 const trialsPath = resolve(process.argv[2] ?? 'data/k-experiment/trials.jsonl');
 const trials: Trial[] = readFileSync(trialsPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Trial);

 // --- per-arm metrics ------------------------------------------------------
 const armMetrics: Record<Arm, ArmMetrics> = {
  control: emptyArm(),
  k3: emptyArm(),
  k5: emptyArm(),
  bestof3: emptyArm(),
 };

 for (const t of trials) {
  const m = armMetrics[t.arm];
  m.attempts += 1;
  if (t.gate.ok && !t.retried) m.passRateFirst += 1;
  if (!t.topic_probe) m.passRateAfterRetry += 1;
  if (t.topic_probe) m.topicProbeRate += 1;
  if (t.gate.reason === 'syntax') m.syntaxCount += 1;
  if (t.gate.reason === 'ungrounded') m.ungroundedCount += 1;
  if (t.gate.reason === 'echo') m.echoCount += 1;
  if (t.gate.reason === 'seedcopy') m.seedcopyCount += 1;

  const windowText = windowTextFromPrompt(t.prompt);
  if (windowText !== null) {
   const ov = groundingOverlap(t.final, windowText);
   if (ov !== null) m.grounding.push(ov);
  }
 }

 for (const arm of ARMS) {
  const m = armMetrics[arm];
  m.passRateFirst = round(m.passRateFirst / m.attempts) ?? 0;
  m.passRateAfterRetry = round(m.passRateAfterRetry / m.attempts) ?? 0;
  m.topicProbeRate = round(m.topicProbeRate / m.attempts) ?? 0;
  m.medianLatMs = median(trials.filter((t) => t.arm === arm).map((t) => t.lat_ms));
  m.meanGrounding = round(median(m.grounding)); // median overlap (robust vs extremes)
 }

 // --- seed survival (k3 / k5 only) -----------------------------------------
 // For each multi-seed trial, the reshaped question's grounding overlap is
 // computed against EACH fed seed separately; the seed with the highest
 // overlap "survives" (its intent won). P(first-listed-seed wins) is reported
 // overall because the first seed is the deterministic anchor of the bundle.
 const seedSurvivalTrials: {
  window: number;
  arm: Arm;
  winnerIndex: number;
  winnerOverlap: number | null;
 }[] = [];

 for (const t of trials) {
  if (t.arm !== 'k3' && t.arm !== 'k5') continue;
  const windowText = windowTextFromPrompt(t.prompt);
  if (windowText === null) continue;
  const overlaps = t.seed_ids.map((id) => groundingOverlap(t.final, id) ?? 0);
  if (overlaps.length === 0) continue;
  let best = 0;
  for (let i = 1; i < overlaps.length; i++) if (overlaps[i] > overlaps[best]) best = i;
  seedSurvivalTrials.push({
   window: t.window,
   arm: t.arm,
   winnerIndex: best,
   winnerOverlap: round(overlaps[best]),
  });
 }
 const firstWins = seedSurvivalTrials.filter((s) => s.winnerIndex === 0).length;
 const pFirstWins =
  seedSurvivalTrials.length > 0 ? round(firstWins / seedSurvivalTrials.length) : null;

 // --- latency delta table (median vs control) ------------------------------
 const latencyMedians: Record<Arm, number | null> = {
  control: armMetrics.control.medianLatMs,
  k3: armMetrics.k3.medianLatMs,
  k5: armMetrics.k5.medianLatMs,
  bestof3: armMetrics.bestof3.medianLatMs,
 };
 const latencyDelta: Record<Arm, number | null> = { ...latencyMedians };
 for (const arm of ARMS) {
  latencyDelta[arm] =
   arm === 'control'
    ? null
    : latencyMedians[arm] !== null && latencyMedians.control !== null
     ? round(latencyMedians[arm]! - latencyMedians.control!)
     : null;
 }

 const metrics = {
  generated: new Date().toISOString(),
  source: trialsPath,
  trials: trials.length,
  arms: Object.fromEntries(
   ARMS.map((arm) => [
    arm,
    {
     attempts: armMetrics[arm].attempts,
     passRateFirst: armMetrics[arm].passRateFirst,
     passRateAfterRetry: armMetrics[arm].passRateAfterRetry,
     topicProbeRate: armMetrics[arm].topicProbeRate,
     medianLatMs: armMetrics[arm].medianLatMs,
     echoCount: armMetrics[arm].echoCount,
     ungroundedCount: armMetrics[arm].ungroundedCount,
     syntaxCount: armMetrics[arm].syntaxCount,
     seedcopyCount: armMetrics[arm].seedcopyCount,
     groundingOverlap: {
      samples: armMetrics[arm].grounding.length,
      median: armMetrics[arm].meanGrounding,
      values: armMetrics[arm].grounding,
     },
    },
   ]),
  ) as Record<
   Arm,
   {
    attempts: number;
    passRateFirst: number;
    passRateAfterRetry: number;
    topicProbeRate: number;
    medianLatMs: number | null;
    echoCount: number;
    ungroundedCount: number;
    syntaxCount: number;
    seedcopyCount: number;
    groundingOverlap: {
     samples: number;
     median: number | null;
     values: number[];
    };
   }
  >,
  seedSurvival: {
   trials: seedSurvivalTrials.length,
   perTrial: seedSurvivalTrials,
   firstSeedWins: firstWins,
   pFirstSeedWins: pFirstWins,
  },
  latency: {
   medianMsByArm: latencyMedians,
   deltaVsControlMs: latencyDelta,
  },
 };

 writeFileSync(resolve('data/k-experiment/metrics.json'), JSON.stringify(metrics, null, 2) + '\n');

 // --- report.html ----------------------------------------------------------
 const sheets = buildSheets(trials);
 writeFileSync(
  resolve('data/k-experiment/report.html'),
  buildHtml(sheets, metrics),
  'utf8',
 );

 // --- one-line summary per arm ---------------------------------------------
 for (const arm of ARMS) {
  const m = armMetrics[arm];
  const ov = m.meanGrounding === null ? 'n/a' : `${(m.meanGrounding * 100).toFixed(0)}%`;
  console.log(
   `${arm.padEnd(8)} n=${m.attempts} first=${(m.passRateFirst * 100).toFixed(0)}% ` +
    `afterRetry=${(m.passRateAfterRetry * 100).toFixed(0)}% probe=${(m.topicProbeRate * 100).toFixed(0)}% ` +
    `medianLat=${m.medianLatMs ?? 'n/a'}ms grounding=${ov}`,
  );
 }
 if (seedSurvivalTrials.length > 0) {
  console.log(
   `seedSurvival n=${seedSurvivalTrials.length} P(firstWins)=${pFirstWins}`,
  );
 }
}

/**
 * Group trials into per-window sheets. Each arm contributes one grading card
 * (its first rep's final question — the representative output for that arm in
 * that window). Cards are then deterministically shuffled and labeled A-D.
 */
function buildSheets(trials: Trial[]): WindowSheet[] {
 const windows = [...new Set(trials.map((t) => t.window))].sort((a, b) => a - b);
 return windows.map((win) => {
  const rows = trials.filter((t) => t.window === win);
  const windowTexts = new Map<number, string>();
  for (const t of rows) {
   if (windowTexts.has(t.window)) continue;
   const w = windowTextFromPrompt(t.prompt);
   if (w !== null) windowTexts.set(t.window, w);
  }
  const windowText = windowTexts.get(win) ?? '';

  const cards: GradingCard[] = [];
  for (const arm of ARMS) {
   const row = rows.find((t) => t.arm === arm && t.rep === 0);
   if (!row) continue;
   cards.push({
    arm,
    rep: row.rep,
    question: row.final,
    overlap: windowText !== '' ? groundingOverlap(row.final, windowText) : null,
    label: '',
   });
  }
  const shuffled = seededShuffle(cards, win);
  const labels = ['A', 'B', 'C', 'D'];
  shuffled.forEach((c, i) => (c.label = labels[i] ?? '?'));
  // The grading key (HTML comment, invisible while rating) decodes each
  // blind label back to its arm so verdicts can be aggregated per arm.
  const key = shuffled.map((c) => `${c.label}=${c.arm}`).join(', ');
  return { window: win, windowText, cards: shuffled, key };
 });
}

// --- HTML assembly ---------------------------------------------------------

const CSS = `
:root{--ink:#1c1e21;--mut:#6b7280;--line:#e5e7eb;--bg:#fafafa;--card:#fff;--accent:#2563eb;}
*{box-sizing:border-box}
body{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--bg);color:var(--ink);padding:24px;line-height:1.45}
h1{font-size:18px;margin:0 0 4px}
h2{font-size:15px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.meta{color:var(--mut);font-size:12px;margin-bottom:18px}
.window{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:18px}
.window-head{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}
.window-head .wn{font-weight:700}
.armgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:6px;padding:10px 12px;background:var(--bg)}
.card .lbl{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.card .q{font-size:12.5px;white-space:pre-wrap;word-break:break-word;margin-bottom:8px}
.card .ov{font-size:11px;color:var(--mut)}
.card .ov b{color:var(--accent)}
label.grade{display:block;margin:2px 0;font-size:12px;cursor:pointer}
textarea{width:100%;min-height:44px;margin-top:8px;border:1px solid var(--line);border-radius:6px;padding:8px;font-family:inherit;font-size:12px;resize:vertical;background:var(--card)}
.actions{margin-top:10px;display:flex;gap:8px;align-items:center}
button{border:1px solid var(--line);background:var(--card);border-radius:6px;padding:6px 12px;font-family:inherit;font-size:12px;cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}
.status{font-size:11px;color:var(--mut)}
table.metrics{border-collapse:collapse;font-size:12px;margin:10px 0}
table.metrics th,table.metrics td{border:1px solid var(--line);padding:5px 10px;text-align:right}
.passage{border:1px solid var(--line);border-left:3px solid var(--mut);background:var(--bg);border-radius:6px;padding:10px 14px;margin-bottom:12px;font-family:Georgia,'Times New Roman',serif;font-size:13.5px}
.passage .plbl{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin-bottom:6px}
.passage p{margin:0 0 8px}
.passage p.cursor-block{border-left:3px solid var(--accent);padding-left:10px;background:#eef4ff}
table.metrics th:first-child,table.metrics td:first-child{text-align:left}


`;

/** Escape text for safe interpolation into HTML. */
function esc(s: string): string {
 return s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
}

/** The slice of metrics the HTML summary table renders. */
interface ReportMetrics {
 trials: number;
 source: string;
 generated: string;
 arms: Record<
  Arm,
  {
   attempts: number;
   passRateFirst: number;
   passRateAfterRetry: number;
   topicProbeRate: number;
   medianLatMs: number | null;
  }
 >;
 latency: { deltaVsControlMs: Record<Arm, number | null> };
}

function buildHtml(sheets: WindowSheet[], metrics: ReportMetrics): string {
const windowSections = sheets
 .map(
  (s) => {
   // The source passage, rendered per paragraph; the block that carried
   // [CURSOR START]/[CURSOR END] gets a visible band so the grader can
   // see exactly where the writer "is".
   const pass = s.windowText
    .split(/\n\s*\n/)
    .map((p) => {
     const marked = p.includes('[CURSOR START]');
     const clean = p.replace(/\[CURSOR START\]/g, '').replace(/\[CURSOR END\]/g, '').trim();
     return `<p class="${marked ? 'cursor-block' : ''}">${esc(clean)}</p>`;
    })
    .join('');
   return `
<section class="window" data-window="${s.window}">
 <div class="window-head"><span class="wn">Window ${s.window}</span></div>
 <div class="passage">
  <div class="plbl">draft window</div>
  ${pass}
 </div>
 <div class="armgrid">
  ${s.cards
   .map(
    (c) => `
  <div class="card">
   <div class="lbl">${c.label}</div>
   <div class="q">${esc(c.question)}</div>
   <div class="ov">grounding: <b>${c.overlap === null ? 'n/a' : `${(c.overlap * 100).toFixed(0)}%`}</b> · rep ${c.rep}</div>
   <label class="grade"><input type="radio" name="bw-window-${s.window}" value="${c.label}"> best</label>
  </div>`,
   )
   .join('')}
 </div>
 <textarea data-note="${s.window}" placeholder="Note for window ${s.window}"></textarea>
</section>`;
  },
 )
 .join('');

 const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>k-experiment grading</title>
<style>${CSS}</style>
</head>
<body>
<h1>k-experiment grading sheet</h1>
<div class="meta">${metrics.trials} trials from ${esc(metrics.source)} · generated ${metrics.generated}</div>

<h2>Per-arm summary</h2>
<table class="metrics">
 <tr><th>arm</th><th>n</th><th>first</th><th>afterRetry</th><th>probe</th><th>medianLat(ms)</th><th>ΔvsCtrl</th></tr>
 ${ARMS.map(
  (arm) => `
 <tr>
  <td>${arm}</td>
  <td>${metrics.arms[arm].attempts}</td>
  <td>${(metrics.arms[arm].passRateFirst * 100).toFixed(0)}%</td>
  <td>${(metrics.arms[arm].passRateAfterRetry * 100).toFixed(0)}%</td>
  <td>${(metrics.arms[arm].topicProbeRate * 100).toFixed(0)}%</td>
  <td>${metrics.arms[arm].medianLatMs ?? 'n/a'}</td>
  <td>${metrics.latency.deltaVsControlMs[arm] ?? '—'}</td>
 </tr>`,
 ).join('')}
</table>

<h2>Grade by window</h2>
<p class="meta">Pick the best reshaped question per window (A–D), add a note, then copy the verdicts. Verdicts autosave to this browser.</p>
${windowSections}

<div class="actions">
 <button id="copyBtn">Copy verdicts JSONL</button>
 <span class="status" id="status"></span>
</div>

<script>
(function () {
 var KEY = 'bw-k-verdicts';
 var store = {};
 try { store = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
 var groups = document.querySelectorAll('section[data-window]');
 groups.forEach(function (sec) {
  var win = sec.getAttribute('data-window');
  var saved = store[win] || {};
  if (saved.choice) {
   var el = sec.querySelector('input[value="' + saved.choice + '"]');
   if (el) el.checked = true;
  }
  var note = sec.querySelector('textarea');
  if (saved.note && note) note.value = saved.note;
  sec.addEventListener('change', function () {
   var c = sec.querySelector('input:checked');
   var n = sec.querySelector('textarea');
   if (!c && !n) return;
   store[win] = store[win] || {};
   if (c) store[win].choice = c.value;
   if (n) store[win].note = n.value;
   save();
  });
  if (note) note.addEventListener('input', function () {
   store[win] = store[win] || {};
   store[win].note = note.value;
   save();
  });
 });
 function save() {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
 }
 document.getElementById('copyBtn').addEventListener('click', function () {
  var verdicts = [];
  groups.forEach(function (sec) {
   var win = Number(sec.getAttribute('data-window'));
   var c = sec.querySelector('input:checked');
   var note = (sec.querySelector('textarea') || {}).value || '';
   if (c) verdicts.push({ window: win, choice: c.value, note: note });
  });
  var text = verdicts.map(function (v) { return JSON.stringify(v); }).join('\\n');
  var status = document.getElementById('status');
  if (navigator.clipboard && navigator.clipboard.writeText) {
   navigator.clipboard.writeText(text).then(function () {
    status.textContent = 'Copied ' + verdicts.length + ' verdicts';
   }, function () { status.textContent = 'Copy failed'; });
  } else {
   status.textContent = text;
  }
 });
})();
</script>

<!-- GRADING KEY
${sheets.map((s) => `window ${s.window}: ${s.key}`).join('\n')}
-->
</body>
</html>`;

 return html;
}

main();
