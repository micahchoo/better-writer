import { describe, expect, it } from 'vitest';
import { TOPIC_PROBES, topicProbe } from './topic-probe.js';
import { isSingleQuestion } from './gate.js';

/**
 * H2-4: probe [5] was an imperative ending in '.', so on every fallback where
 * `textWindow.length % 6 === 5` the writer got a directive — from the one path
 * guaranteed to run, and one that fails the app's own gate.
 */
describe('every topic probe is a single question (H2-4)', () => {
 it('passes the gate the app applies to model output', () => {
  for (const probe of TOPIC_PROBES) {
   expect(isSingleQuestion(probe), probe).toBe(true);
  }
 });

 it('covers every probe index, so no directive can hide in one', () => {
  const seen = new Set<string>();
  for (let n = 0; n < TOPIC_PROBES.length * 4; n++) seen.add(topicProbe('x'.repeat(n)));
  expect(seen.size).toBe(TOPIC_PROBES.length);
 });

 it('is deterministic for a given window length', () => {
  expect(topicProbe('abcde')).toBe(topicProbe('vwxyz'));
 });
});
