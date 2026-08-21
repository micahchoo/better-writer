import { describe, expect, it } from 'vitest';
import { parsePullOutput } from './seed.js';

/** Exactly what `retrieve.py pull` prints: a JSON array, indent=2. */
const CANNED_PULL = JSON.stringify(
 [
  {
   id: 'lg-steering-1',
   question: 'What is at stake here?',
   verb: 'concept-form',
   genre: ['fiction'],
   source: {
    book: 'Steering the Craft',
    author: 'Ursula K. Le Guin',
    chapter: 'ch1',
    quote: 'Some quoted text.',
   },
  },
 ],
 null,
 2,
);

describe('parsePullOutput', () => {
 it('parses a canned retrieve.py JSON array and returns the first seed', () => {
  const seed = parsePullOutput(CANNED_PULL);
  expect(seed.id).toBe('lg-steering-1');
  expect(seed.question).toBe('What is at stake here?');
  expect(seed.genre).toEqual(['fiction']);
  expect(seed.source.author).toBe('Ursula K. Le Guin');
 });

 it('throws a clear error on an empty array', () => {
  expect(() => parsePullOutput('[]')).toThrow(/no seeds/);
 });

 it('throws a clear error on unparseable output', () => {
  expect(() => parsePullOutput('not json at all')).toThrow(/invalid JSON/);
 });

 it('throws a clear error on a non-array payload', () => {
  expect(() => parsePullOutput('{"question": "what?"}')).toThrow(/no seeds/);
 });

 it('throws a clear error on a malformed seed', () => {
  expect(() => parsePullOutput(JSON.stringify([{ id: 'x' }]))).toThrow(/malformed seed/);
 });
});
