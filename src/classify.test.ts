import { describe, expect, it } from 'vitest';
import { CLASSIFY_SYSTEM, classifyVerbs, pickVerb } from './classify.js';
import type { Complete, Turn, Verb } from './types.js';

function makeComplete(output: string): Complete {
  return async () => output;
}

describe('classifyVerbs', () => {
 it('parses a clean 3-line ranked output in order', async () => {
  const complete = makeComplete('cut\nelaborate\nrewrite');
  await expect(classifyVerbs('some passage', complete)).resolves.toEqual([
   'cut',
   'elaborate',
   'rewrite',
  ]);
 });

 it('strips one trailing punctuation char and numbered markers', async () => {
  const complete = makeComplete('1. cut.\n2) elaborate:\n3. rewrite-');
  await expect(classifyVerbs('some passage', complete)).resolves.toEqual([
   'cut',
   'elaborate',
   'rewrite',
  ]);
 });

 it('tolerates junk and extra lines and dedupes repeated verbs', async () => {
  const complete = makeComplete(
   'Here is some preamble the model slipped in.\ncut\nelaborate\ncut\nrewrite\nconcept-form',
  );
  await expect(classifyVerbs('some passage', complete)).resolves.toEqual([
   'cut',
   'elaborate',
   'rewrite',
  ]);
 });

 it('accepts uppercase output', async () => {
  const complete = makeComplete('CUT\nELABORATE\nREWRITE');
  await expect(classifyVerbs('some passage', complete)).resolves.toEqual([
   'cut',
   'elaborate',
   'rewrite',
  ]);
 });

 it('caps the shortlist at three verbs', async () => {
  const complete = makeComplete('cut\nelaborate\nrewrite\ntransition');
  await expect(classifyVerbs('some passage', complete)).resolves.toEqual([
   'cut',
   'elaborate',
   'rewrite',
  ]);
 });

 it('returns [] when complete throws', async () => {
  const complete: Complete = async () => {
   throw new Error('model down');
  };
  await expect(classifyVerbs('some passage', complete)).resolves.toEqual([]);
 });

 it('returns [] when complete returns garbage', async () => {
  const complete = makeComplete('lorem ipsum dolor\n123\n\n');
  await expect(classifyVerbs('some passage', complete)).resolves.toEqual([]);
 });

 it('returns [] for empty output', async () => {
  const complete = makeComplete('');
  await expect(classifyVerbs('some passage', complete)).resolves.toEqual([]);
 });

 it('passes the CLASSIFY_SYSTEM prompt and a user passage turn to complete', async () => {
  let seenSystem: string | undefined;
  let seenTurns: Turn[] | undefined;
  const complete: Complete = async (system, turns) => {
   seenSystem = system;
   seenTurns = turns;
   return 'cut\nelaborate\nrewrite';
  };
  await classifyVerbs('the passage text', complete);
  expect(seenSystem).toBe(CLASSIFY_SYSTEM);
  expect(seenTurns).toEqual([
   { role: 'user', text: 'Passage:\nthe passage text\n\nMost useful interventions, ranked:' },
  ]);
 });
});

describe('pickVerb', () => {
 it('returns null for an empty shortlist', () => {
  expect(pickVerb([])).toBeNull();
  expect(pickVerb([], 0)).toBeNull();
  expect(pickVerb([], 1)).toBeNull();
 });

 it('always yields the verb of a 1-verb list across many draws (floor 0)', () => {
  const ranked: Verb[] = ['cut'];
  for (let i = 0; i < 200; i++) {
   expect(pickVerb(ranked, 0)).toBe('cut');
  }
 });

 it('never returns anything outside the ranked list or null across 500 draws', () => {
  const ranked: Verb[] = ['rewrite', 'elaborate', 'transition'];
  for (let i = 0; i < 500; i++) {
   const picked = pickVerb(ranked);
   expect(picked === null || ranked.includes(picked)).toBe(true);
  }
 });

 it('is always null when the floor is 1', () => {
  const ranked: Verb[] = ['cut', 'elaborate', 'rewrite'];
  for (let i = 0; i < 200; i++) {
   expect(pickVerb(ranked, 1)).toBeNull();
  }
 });

 it('is never null when the floor is 0 on a 3-verb list', () => {
  const ranked: Verb[] = ['cut', 'elaborate', 'rewrite'];
  for (let i = 0; i < 200; i++) {
   expect(pickVerb(ranked, 0)).not.toBeNull();
  }
 });

 it('uses 0.12 as the default floor', () => {
  const ranked: Verb[] = ['cut', 'elaborate', 'rewrite'];
  const draws = 2000;
  let nulls = 0;
  for (let i = 0; i < draws; i++) {
   if (pickVerb(ranked) === null) {
    nulls++;
   }
  }
  // ~12% floor; with 2000 draws a 2% band is a ~3-sigma margin.
  expect(nulls / draws).toBeGreaterThan(0.1);
  expect(nulls / draws).toBeLessThan(0.14);
 });
});
