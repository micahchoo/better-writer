/**
 * k-report-pair: a PAIRED view of the k-experiment trials.
 *
 * The 4-way grading sheet cannot distinguish "multi-K preferred" from
 * grader indifference: indifferent clicking lands on some multi-K arm
 * 75% of the time by construction. This sheet forces the discriminating
 * comparison — per window, the CONTROL output (one seed) against the K3
 * output (three seeds), same rep index, same window text — shuffled left/
 * right, judged blind, one radio per pair.
 *
 * Reads the same trials.jsonl as k-report; writes
 * data/k-experiment/report-pair.html + pair-key.json (label->arm decode,
 * kept OUT of the HTML so blindness survives peeking at source).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The trial shape, per the k-experiment contract. */
interface Trial {
 window: number;
 arm: 'control' | 'k3' | 'k5' | 'bestof3';
 rep: number;
 final: string;
 prompt: string;
}

/** Deterministic PRNG so side-shuffles are stable across regenerations. */
function mulberry32(seed: number): () => number {
 return function () {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
 let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
 t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
 return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
 };
}

/** The trial fields the pairwise sheet needs from trials.jsonl. */
interface PairRow {
 pair: number;
 window: number;
 rep: number;
 leftText: string;
 rightText: string;
 leftArm: string;
 rightArm: string;
 /** Rendered passage paragraphs for this window's sheet, built with the row. */
 passageHtml: string;
}

function esc(s: string): string {
 return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The passage sits between '\nPassage:\n' and '\n\nReminder:' in the prompt. */
function windowTextFromPrompt(prompt: string): string {
 const a = prompt.indexOf('\nPassage:\n');
 const b = prompt.indexOf('\n\nReminder:');
 if (a === -1 || b === -1 || b <= a) return '';
 return prompt.slice(a + '\nPassage:\n'.length, b);
}

const CSS = `
body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#fafafa;color:#1c1e21;padding:24px;line-height:1.45}
h1{font-size:18px;margin:0 0 4px}
.meta{color:#6b7280;font-size:12px;margin-bottom:18px}
.pair{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:18px}
.phead{font-weight:700;margin-bottom:10px}
.passage{border-left:3px solid #6b7280;background:#fff;border-radius:4px;padding:10px 14px;margin-bottom:12px;font-family:Georgia,'Times New Roman',serif;font-size:13.5px}
.passage .plbl{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:6px}
.passage p{margin:0 0 8px}
.passage p.cursor-block{border-left:3px solid #2563eb;padding-left:10px;background:#eef4ff}
.opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.opt{border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;background:#fafafa}
.opt label{display:block;cursor:pointer;font-size:12px}
.opt .q{font-family:Georgia,serif;font-size:13px;margin:6px 0}
button{border:1px solid #e5e7eb;background:#fff;border-radius:6px;padding:6px 12px;font-family:inherit;font-size:12px;cursor:pointer}
.status{font-size:11px;color:#6b7280;margin-left:10px}
`;

function main(): void {
 const trialsPath = resolve(process.argv[2] ?? 'data/k-experiment/trials.jsonl');
 const trials: Trial[] = readFileSync(trialsPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Trial);

 const windows = [...new Set(trials.map((t) => t.window))].sort((a, b) => a - b);
 const REPS_PER_PAIR_SET = 3; // every control rep pairs against the same-index k3 rep

 interface PairRow {
  pair: number;
  window: number;
  rep: number;
  leftText: string;
  rightText: string;
  leftArm: string;
  rightArm: string;
  /** Rendered passage paragraphs for this window, built once per window. */
  passageHtml: string;
 }

 const rows: PairRow[] = [];
 const key: Record<string, { window: number; rep: number; left: string; right: string }> = {};
 let pairId = 0;

 for (const win of windows) {
  const rowsWin = trials.filter((t) => t.window === win && (t.arm === 'control' || t.arm === 'k3'));
  const winText = windowTextFromPrompt(rowsWin[0]?.prompt ?? '');
  const passageHtml = winText
   .split(/\n\s*\n/)
   .map((p) => {
    const marked = p.includes('[CURSOR START]');
    const clean = p.replace(/\[CURSOR START\]/g, '').replace(/\[CURSOR END\]/g, '').trim();
    return `<p class="${marked ? 'cursor-block' : ''}">${esc(clean)}</p>`;
   })
   .join('');

  for (let rep = 0; rep < REPS_PER_PAIR_SET; rep++) {
   const ctl = rowsWin.find((t) => t.arm === 'control' && t.rep === rep);
   const k3r = rowsWin.find((t) => t.arm === 'k3' && t.rep === rep);
   if (!ctl || !k3r) continue;
   // Seed each pair's side-flip deterministically; store the true mapping.
   const rnd = mulberry32(win * 100 + rep);
   const kLeft = rnd() < 0.5;
   const row: PairRow = {
    pair: pairId,
    window: win,
    rep,
    leftText: kLeft ? k3r.final : ctl.final,
    rightText: kLeft ? ctl.final : k3r.final,
    leftArm: kLeft ? 'k3' : 'control',
    rightArm: kLeft ? 'control' : 'k3',
    passageHtml,
   };
   rows.push(row);
   key[String(pairId)] = { window: win, rep, left: row.leftArm, right: row.rightArm };
   pairId++;
  }
 }

 // Passage HTML travels with the row (captured at build time above).
 const sections = rows
  .map(
   (r) => `
<section class="pair" data-pair="${r.pair}">
 <div class="phead">Pair ${r.pair} <span style="color:#6b7280">(window ${r.window}, variant ${r.rep})</span></div>
 <div class="passage"><div class="plbl">draft window</div>${r.passageHtml}</div>
 <div class="opts">
  <div class="opt"><div class="q">${esc(r.leftText)}</div><label><input type="radio" name="bw-pair-${r.pair}" value="L"> this one</label></div>
  <div class="opt"><div class="q">${esc(r.rightText)}</div><label><input type="radio" name="bw-pair-${r.pair}" value="R"> this one</label></div>
 </div>
</section>`,
  )
  .join('');

 const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>k-experiment pairwise grading</title><style>${CSS}</style></head><body>
<h1>pairwise: one seed vs three</h1>
<div class="meta">${rows.length} pairs &middot; pick the better reshaped question per pair &middot; progress autosaves locally</div>
${sections}
<div><button id="copyBtn">Copy verdicts JSONL</button><span class="status" id="status"></span></div>
<script>
(function () {
 var KEY='bw-k-pair-verdicts',store={};
 try{store=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){}
 document.querySelectorAll('section[data-pair]').forEach(function(sec){
  var id=sec.getAttribute('data-pair');
  var saved=store[id]||{};
  if(saved.choice){var el=sec.querySelector('input[value="'+saved.choice+'"]');if(el)el.checked=true;}
  sec.addEventListener('change',function(){
   var c=sec.querySelector('input:checked');if(!c)return;
   store[id]={choice:c.value};save();
  });
 });
 function save(){try{localStorage.setItem(KEY,JSON.stringify(store))}catch(e){}}
 document.getElementById('copyBtn').addEventListener('click',function(){
  var out=[];
  document.querySelectorAll('section[data-pair]').forEach(function(sec){
   var c=sec.querySelector('input:checked');if(!c)return;
   out.push({pair:Number(sec.getAttribute('data-pair')),choice:c.value});
  });
  var text=out.map(function(v){return JSON.stringify(v)}).join('\\n');
  var st=document.getElementById('status');
  navigator.clipboard.writeText(text).then(function(){st.textContent='Copied '+out.length+' verdicts'},function(){st.textContent=text;});
 });
})();
</script>
</body></html>`;

 writeFileSync(resolve('data/k-experiment/report-pair.html'), html);
 // Decode lives outside the page: blindness survives view-source.
 writeFileSync(resolve('data/k-experiment/pair-key.json'), JSON.stringify(key, null, 2));
 console.log(`pairs=${rows.length} windows=${windows.length}`);
}

main();

