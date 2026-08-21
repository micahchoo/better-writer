import { describe, expect, it } from 'vitest';
import { reshape } from './reshape.js';
import { TOPIC_PROBES } from './topic-probe.js';
import type { Complete, Turn } from './types.js';

describe('reshape', () => {
 it('passes a clean single question through unchanged', async () => {
  const complete: Complete = async () => 'What is actually at stake in the kitchen scene?';
  const out = await reshape('What is at stake here?', 'The kitchen scene.', complete);
  expect(out).toBe('What is actually at stake in the kitchen scene?');
 });

 it('feeds the model only the seed question and the text window — never provenance', async () => {
  const prompts: string[] = [];
  const complete: Complete = async (_system, turns) => {
   prompts.push(turns[0].text);
   return 'What is actually at stake here?';
  };
  await reshape(
   'What is at stake here?',
   'The kitchen scene.',
   complete,
  );
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('Question: What is at stake here?');
  expect(prompts[0]).toContain('Writer\'s text:\nThe kitchen scene.');
  expect(prompts[0]).not.toContain('Le Guin');
  expect(prompts[0]).not.toContain('Steering the Craft');
  expect(prompts[0]).not.toContain('concept-form');
 });

 it('retries once with a corrective prompt, then falls back to a topic probe when both outputs are bad', async () => {
  const prompts: string[] = [];
  const complete: Complete = async (_system, turns) => {
   prompts.push(turns[0].text);
   // Trailing text after the final `?` — the gate rejects it.
   return 'Sure! Here is a nice question for you: What changed? Let me know what you think.';
  };
  const out = await reshape('What is at stake here?', 'some text', complete);
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).not.toContain('Return only the single question. Nothing else.');
  expect(prompts[1]).toContain('Return only the single question. Nothing else.');
  // Fallback is a deterministic topic probe for this window: 9 chars % 6 = 3.
  expect(out).toBe(TOPIC_PROBES['some text'.length % TOPIC_PROBES.length]);
  // Deterministic: the same window yields the same probe again.
  const again = await reshape('What is at stake here?', 'some text', complete);
  expect(again).toBe(out);
 });

 it('falls back to a topic probe when the model throws', async () => {
  const complete: Complete = async () => {
   throw new Error('model down');
  };
  const out = await reshape('What is at stake here?', 'abc', complete);
  expect(out).toBe(TOPIC_PROBES['abc'.length % TOPIC_PROBES.length]);
 });

 it('recovers on the retry when only the first output is bad', async () => {
  const complete: Complete = async (_system, turns) => {
   const isRetry = turns[0].text.includes('Return only the single question. Nothing else.');
   // First output has a second `?` — the gate rejects it.
   return isRetry ? 'What is actually at stake here?' : 'Sure, here is my take: What is at stake? And what changed?';
  };
  const out = await reshape('What is at stake here?', 'The kitchen scene.', complete);
  expect(out).toBe('What is actually at stake here?');
 });
});
