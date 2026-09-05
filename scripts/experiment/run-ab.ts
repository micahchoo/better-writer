/**
 * Offline A/B: baseline uniform pull vs ruler-narrowed two-stage pull.
 * No server, no model calls; reads only seeds/bank.jsonl + fixtures.
 *
 * Outputs (scripts/experiment/out/):
 *   draws.jsonl  — every draw with arm + scores
 *   metrics.json — aggregate rates per fixture and overall
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measureWindow } from '../../src/core/window-stats';
import {
  loadSeeds,
  pullBaseline,
  pullTreated,
  topicMatch,
  makeRng,
  type Seed,
} from './arms';
import { FIXTURES, type Fixture } from './fixtures';

const REPS = 30;
const SEED_ROOT = 20260823;

interface DrawRow {
  fixture: string;
  rep: number;
  arm: 'baseline' | 'treated';
  seedId: string;
  verb: string;
  /** loose = ANY fixture trueTopic matched lexically */
  looseHit: boolean;
  /** strict = the fixture's FIRST-named trueTopic only */
  strictHit: boolean;
  verbAlign: boolean | null; // null when fixture implies no verb
}

function scoreDraw(f: Fixture, seed: Seed): Omit<DrawRow, 'fixture' | 'rep' | 'arm'> {
  const looseHit = f.trueTopics.some((t) => topicMatch(seed, t));
  return {
    seedId: seed.id,
    verb: seed.verb,
    looseHit,
    strictHit: f.trueTopics.length > 0 && topicMatch(seed, f.trueTopics[0]),
    verbAlign: f.impliedVerbs.length === 0 ? null : f.impliedVerbs.includes(seed.verb),
  };
}

function main() {
  const bank = loadSeeds(join(__dirname, '..', '..', 'seeds', 'bank.jsonl'));
  const rows: DrawRow[] = [];
  const flagReport: Array<{ fixture: string; expected: string[]; fired: string[] }> = [];

  for (const f of FIXTURES) {
    const stats = measureWindow(f.window, f.positionContext);
    flagReport.push({ fixture: f.name, expected: f.expectedFlags, fired: [...stats.axes] });
    // retrieve.py semantics: genre-agnostic entries are wildcards.
    const pool = bank.filter((s) => s.genre.includes('genre-agnostic') || s.genre.includes(f.genre));

    for (let rep = 0; rep < REPS; rep++) {
      const b = pullBaseline(pool, makeRng(SEED_ROOT + rep * 2 + 1));
      rows.push({ fixture: f.name, rep, arm: 'baseline', ...scoreDraw(f, b) });

      const t = pullTreated(pool, new Set(stats.axes), makeRng(SEED_ROOT + rep * 2 + 2));
      rows.push({ fixture: f.name, rep, arm: 'treated', ...scoreDraw(f, t) });
    }
  }

  // 3+ call sites need lockstep rates (loose/strict x arms): named binomial SE.
  function se(p: number, n: number): number {
    if (n === 0) return NaN;
    return Math.sqrt((p * (1 - p)) / n);
  }

  const agg = (arm: 'baseline' | 'treated', include: (f: Fixture) => boolean) => {
    const names = new Set(FIXTURES.filter(include).map((f) => f.name));
    const rs = rows.filter((r) => r.arm === arm && names.has(r.fixture));
    const verbRows = rs.filter((r) => r.verbAlign !== null);
    const loose = mean(rs.map((r) => Number(r.looseHit)));
    const strict = mean(rs.map((r) => Number(r.strictHit)));
    const verb = mean(verbRows.map((r) => Number(r.verbAlign)));
    return { loose, strict, verb, n: rs.length, seLoose: se(loose, rs.length), seVerb: se(verb, verbRows.length) };
  };

  const controls = (f: Fixture) => f.expectedFlags.length === 0;
  const flaggedOnly = (f: Fixture) => f.expectedFlags.length > 0;

  const metrics = {
    repsPerArm: REPS,
    rulersVsExpected: flagReport,
    overall: { baseline: agg('baseline', () => true), treated: agg('treated', () => true) },
    flaggedFixtures: { baseline: agg('baseline', flaggedOnly), treated: agg('treated', flaggedOnly) },
    controlFixtures: { baseline: agg('baseline', controls), treated: agg('treated', controls) },
  };

  const outDir = join(__dirname, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'draws.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
}

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

main();
