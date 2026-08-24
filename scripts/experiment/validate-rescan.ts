/**
 * Mechanical gate for rescan-staged seeds BEFORE insertion into the bank.
 * Usage: bun scripts/experiment/validate-rescan.ts <staging.json> [<staging.json> ...]
 * Exit 1 on any failure; prints per-file report.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface StagedSeed {
  id: string;
  question: string;
  verb: string;
  genre: string[];
  source: { book: string; author: string; chapter: string; quote: string };
}

const R = fileURLToPath(new URL('../..', import.meta.url));
const BOOKS: Record<string, string> = {
  'Stein On Writing': "Books/Sol Stein, David Stanford Burr, Pei Loi Koay - Stein On Writing_ A Master Editor of Some of the Most Successful Writers of Our Century Shares His Craft Techniques and Strateg (1995, St. Martin's Press) - libgen.li.md",
  'Showing & Telling': 'Books/Laurie Alberts - Showing & Telling_ Learn How to Show & When to Tell for Powerful & Balanced Writing (2010) - libgen.li.md',
  'Steering the Craft': 'scripts/experiment/out/le-guin-2015-full.txt',
};
const AUTHORS: Record<string, string> = {
  'Stein On Writing': 'Sol Stein',
  'Showing & Telling': 'Laurie Alberts',
  'Steering the Craft': 'Ursula K. Le Guin',
};
const VERBS = new Set(['rewrite', 'elaborate', 'elucidate', 'cut', 'transition', 'concept-form', 'rephrase']);
const GENRES = new Set(['fiction', 'creative-nonfiction', 'memoir', 'essay', 'poetry', 'genre-agnostic']);

function norm(s: string): string { return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim(); }
function words8(s: string): string { return norm(s).split(' ').slice(0, 8).join(' '); }

let failures = 0;
function fail(file: string, id: string, msg: string) { console.log(`FAIL ${file} ${id}: ${msg}`); failures++; }

const bank: StagedSeed[] = readFileSync(join(R, 'seeds', 'bank.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as StagedSeed);
const bankPrefixes = new Set(bank.map((s) => words8(s.question)));
const bankIds = new Set(bank.map((s) => s.id));

const bookText: Record<string, string> = {};
for (const [k, rel] of Object.entries(BOOKS)) bookText[k] = norm(readFileSync(join(R, rel), 'utf8'));

for (const path of process.argv.slice(2)) {
  const file = path.split('/').pop() ?? path;
  let seeds: StagedSeed[];
  try { seeds = JSON.parse(readFileSync(path, 'utf8')) as StagedSeed[]; }
  catch (e) { fail(file, '-', `unparseable JSON: ${(e as Error).message}`); continue; }

  const batchPrefixes = new Set<string>();
  for (const s of seeds) {
    if (!s.id || !s.question || !s.verb || !Array.isArray(s.genre) || !s.source) { fail(file, s.id ?? '?', 'missing top-level field(s)'); continue; }
    if (bankIds.has(s.id)) fail(file, s.id, 'id already exists in bank');
    if (!VERBS.has(s.verb)) fail(file, s.id, `bad verb ${s.verb}`);
    if (!s.genre.every((g) => GENRES.has(g))) fail(file, s.id, 'bad genre tag');
    const b = s.source;
    if (!(b.book in BOOKS)) { fail(file, s.id, `unknown book "${b.book}"`); continue; }
    if (b.author !== AUTHORS[b.book]) fail(file, s.id, 'author mismatch');
    if (!b.quote) { fail(file, s.id, 'missing quote'); continue; }

    const nq = norm(String(b.quote));
    if (nq.length > 0 && !bookText[b.book].includes(nq)) fail(file, s.id, 'quote NOT found verbatim in book');

    const p = words8(s.question);
    if (p && bankPrefixes.has(p)) fail(file, s.id, 'first-8-words collide with existing bank question');
    if (batchPrefixes.has(p)) fail(file, s.id, 'first-8-words duplicate inside batch');
    if (p) batchPrefixes.add(p);
    if (String(s.question).length > 200) fail(file, s.id, `question ${s.question.length} chars > 200`);
  }
  const verbs: Record<string, number> = {};
  for (const s of seeds) verbs[s.verb] = (verbs[s.verb] ?? 0) + 1;
  console.log(`OK-SUMMARY ${file}: ${seeds.length} staged, verbs=${JSON.stringify(verbs)}`);
}
process.exit(failures ? 1 : 0);
