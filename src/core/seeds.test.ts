import { describe, expect, it } from 'vitest';
import { drawCandidates } from './seeds.js';
import type { ClientSeed, CoachInput } from './types.js';
const input: CoachInput = { textWindow: 'The copper kettle remained cold.', genre: 'fiction', cursorOffset: 0 };
const seeds: ClientSeed[] = [
  { id: 'a', question: 'First question?', genre: ['fiction'], verb: 'cut' },
  { id: 'b', question: 'Second question?', genre: ['fiction'], verb: 'cut' },
  { id: 'c', question: 'Third question?', genre: ['genre-agnostic'], verb: 'elaborate' },
  { id: 'd', question: 'Poetry question?', genre: ['poetry'], verb: 'transition' },
  { id: 'e', question: 'First question?', genre: ['fiction'], verb: 'rephrase' },
];
const rng = { random: () => 0, choice: <T>(values: T[]) => values[0] };

describe('shared candidate selection', () => {
  it('filters genre, deduplicates questions, and spreads intervention kinds', () => {
    const candidates = drawCandidates(seeds, input, 3, rng);
    expect(candidates.map(seed => seed.id)).toEqual(['a', 'c', 'b']);
    expect(new Set(candidates.map(seed => seed.question)).size).toBe(3);
    expect(seeds).toHaveLength(5);
  });
  it('bounds draws to the requested count and available distinct questions', () => {
    expect(drawCandidates(seeds, input, 1, rng)).toHaveLength(1);
    expect(drawCandidates(seeds, input, 10, rng)).toHaveLength(3);
    expect(drawCandidates(seeds, input, 0, rng)).toEqual([]);
    expect(drawCandidates([], input, 3, rng)).toEqual([]);
  });
});
