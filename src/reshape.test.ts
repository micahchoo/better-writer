import { describe, expect, it, vi } from 'vitest';
import { reshape } from './reshape.js';
import { TOPIC_PROBES } from './topic-probe.js';
import type { Complete, Turn } from './types.js';

/**
 * The corrective nudges keyed by gate-failure reason (must mirror reshape.ts
 * byte-for-byte: reshape picks the suffix by the first predicate the output
 * failed).
 */
const SUFFIXES = {
 syntax:
  'Return only the single question, ending in ?. Nothing else.',
 ungrounded:
  'Your question did not mention anything from the writer\'s text. Ask about a specific detail from the text and quote its exact words in the question.',
 echo:
  'You restated the writer\'s sentences back as a question. Ask about their text without repeating their sentences — quote one small detail, then ask something new about it.',
 seedcopy:
  'You repeated the seed question almost verbatim. Do not reuse the seed\'s wording; write a fresh question about the writer\'s text.',
};

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
   return 'What is actually at stake in the kitchen scene?';
  };
  await reshape(
   'What is at stake here?',
   'The kitchen scene.',
   complete,
  );
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('Craft question (the intent you must keep):\nWhat is at stake here?');
  expect(prompts[0]).toContain('Passage:\nThe kitchen scene.');
  expect(prompts[0]).not.toContain('Le Guin');
  expect(prompts[0]).not.toContain('Steering the Craft');
  expect(prompts[0]).not.toContain('concept-form');
 });

 it('retries once with a corrective prompt, then falls back to a topic probe when both outputs are bad', async () => {
  const prompts: string[] = [];
  const complete: Complete = async (_system, turns) => {
   prompts.push(turns[0].text);
   // Two question marks — the syntactic gate rejects it.
   return 'Sure! Here is a nice question for you: What changed? Let me know what you think.';
  };
  const out = await reshape('What is at stake here?', 'some text', complete);
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).not.toContain(SUFFIXES.syntax);
  expect(prompts[1]).toContain(SUFFIXES.syntax);
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
   const isRetry = turns[0].text.includes(SUFFIXES.syntax);
   // First output has a second `?` — the gate rejects it.
   return isRetry
    ? 'What is actually at stake in the kitchen scene?'
    : 'Sure, here is my take: What is at stake? And what changed?';
  };
  const out = await reshape('What is at stake here?', 'The kitchen scene.', complete);
  expect(out).toBe('What is actually at stake in the kitchen scene?');
 });

 it('recovers grounding on the retry when the first output is a single question but shares no window words', async () => {
  const complete: Complete = async (_system, turns) => {
   const isRetry = turns[0].text.includes(SUFFIXES.ungrounded);
   // First output passes the syntactic gate but is ungrounded: none of its
   // content words ('actually', 'stake') appear in the window. The retry
   // output borrows window words ('walk', 'store', 'milk').
   return isRetry
    ? 'Why did she walk to the store before buying milk?'
    : 'What is actually at stake here?';
  };
  const out = await reshape(
   'What drives a character\'s decision to linger?',
   'She walked to the store. She bought milk. She came home.',
   complete,
  );
  expect(out).toBe('Why did she walk to the store before buying milk?');
 });

 it('uses the echo suffix when the first output restates the window', async () => {
  const prompts: string[] = [];
  const complete: Complete = async (_system, turns) => {
   prompts.push(turns[0].text);
   return turns[0].text.includes(SUFFIXES.echo)
    ? 'What would a concrete example of the new paradigm look like in an everyday workplace?'
    : 'Does the new paradigm represent a fundamental shift in how we understand the relationship between technology and humanity in the contemporary moment?';
  };
  const window = 'The new paradigm represents a fundamental shift in how we understand the relationship between technology and humanity in the contemporary moment.';
  const out = await reshape(
   'Make the abstract claim concrete by anchoring it in a particular instance.',
   window,
   complete,
  );
  expect(prompts[1]).toContain(SUFFIXES.echo);
  expect(out).toBe('What would a concrete example of the new paradigm look like in an everyday workplace?');
 });

 it('uses the seedcopy suffix when the first output repeats the seed', async () => {
  const prompts: string[] = [];
  const complete: Complete = async (_system, turns) => {
   prompts.push(turns[0].text);
   return turns[0].text.includes(SUFFIXES.seedcopy)
    ? 'Which adjectives in your draft earn their place?'
    : 'Should you cut every redundant adjective from your draft?';
  };
  const out = await reshape(
   'Cut every redundant adjective from your draft.',
   'Your draft has too many adjectives.',
   complete,
  );
  expect(prompts[1]).toContain(SUFFIXES.seedcopy);
  expect(out).toBe('Which adjectives in your draft earn their place?');
 });

 it('decodes cursor marker tokens out of the answer before the gate', async () => {
  const complete: Complete = async () =>
   'Does the [CURSOR START] garden refuse naming [CURSOR END]?';
  const out = await reshape('What is at stake here?', 'The garden refuses every naming attempt.', complete);
  expect(out).toBe('Does the garden refuse naming ?');
  expect(out).not.toContain('[CURSOR START]');
  expect(out).not.toContain('[CURSOR END]');
 });

 it('decodes before gating, so a marker-induced trailing token no longer burns a retry', async () => {
  const complete = vi.fn(async () => 'Why did she walk to the store before buying milk? [CURSOR END]');
  const out = await reshape(
   'What is at stake here?',
   'She walked to the store. She bought milk.',
   complete,
  );
  // The trailing `[CURSOR END]` was the output's only gate problem: it used to
  // fail isSingleQuestion and exhaust the retry; decoding pre-gate passes on
  // the first call, so the model is never re-prompted.
  expect(complete).toHaveBeenCalledTimes(1);
  expect(out).toBe('Why did she walk to the store before buying milk?');
});
});
