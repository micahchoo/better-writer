import { describe, expect, it, vi } from 'vitest';
import { askFromCandidates } from './agent.js';
import type { CoachInput } from './types.js';

const input: CoachInput = { textWindow: 'Morning came. Her copper kettle stayed cold.', genre: 'fiction', cursorOffset: 20, focus: { start: 14, end: 43 } };
const questions = ['What does the setting reveal about the conflict?', 'How might sensory details carry emotional weight?'];
const valid = { kind: 'question', candidate: 2, question: 'What do you want the "copper kettle" to suggest about her reluctance?', quote: 'copper kettle' };
const output = (value: unknown) => JSON.stringify(value);

describe('askFromCandidates', () => {
  it('selects an applicable candidate and computes window-relative evidence', async () => {
    const complete = vi.fn().mockResolvedValue(output(valid));
    const diagnostics = vi.fn();
    expect(await askFromCandidates(input, questions, complete, undefined, diagnostics)).toEqual({
      kind: 'question', question: valid.question, source: 'reshaped', evidence: { quote: 'copper kettle', start: 18, end: 31 },
    });
    expect(diagnostics).toHaveBeenCalledWith({ attempts: 1, failures: [], selectedIndex: 2, outcome: 'question' });
    expect(complete.mock.calls[0][1][0].text).toContain('2.');
    expect(complete.mock.calls[0][2]).toMatchObject({ temperature: 0 });
  });

  it('accepts explicit no-fit without retry', async () => {
    const complete = vi.fn().mockResolvedValue('{"kind":"skip"}');
    expect(await askFromCandidates(input, questions, complete)).toEqual({ kind: 'skip', reason: 'no-fit' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['unknown field', output({ ...valid, explanation: 'reason' })],
    ['bad candidate', output({ ...valid, candidate: 3 })],
    ['fractional candidate', output({ ...valid, candidate: 1.5 })],
    ['advice and question', output({ ...valid, question: 'Add sensory detail. What does the "copper kettle" mean?' })],
    ['hallucinated quote', output({ ...valid, quote: 'silver kettle' })],
    ['unused quote', output({ ...valid, question: 'What do you want this detail to suggest?' })],
    ['outside focus', output({ ...valid, quote: 'Morning', question: 'How do you want "Morning" to shape the tension?' })],
    ['generic quote', output({ ...valid, quote: 'Her', question: 'What do you want "Her" to suggest emotionally?' })],
    ['substring evidence', output({ ...valid, quote: 'copp', question: 'What could "copp" suggest emotionally?' })],
  ])('rejects %s after one bounded retry', async (_name, response) => {
    const complete = vi.fn().mockResolvedValue(response);
    expect(await askFromCandidates(input, questions, complete)).toEqual({ kind: 'skip', reason: 'invalid-output' });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('rejects ambiguous evidence but permits a focus that disambiguates it', async () => {
    const repeated = { ...input, textWindow: 'copper kettle and copper kettle', focus: undefined };
    const complete = vi.fn().mockResolvedValue(output(valid));
    expect(await askFromCandidates(repeated, questions, complete)).toEqual({ kind: 'skip', reason: 'invalid-output' });
    expect(await askFromCandidates({ ...repeated, focus: { start: 18, end: 31 } }, questions, complete)).toMatchObject({ kind: 'question', evidence: { start: 18, end: 31 } });
  });

  it('rejects echo and copying the selected seed', async () => {
    const echo = { ...valid, question: 'Her copper kettle stayed cold?', quote: 'copper kettle' };
    expect(await askFromCandidates(input, questions, vi.fn().mockResolvedValue(output(echo)))).toEqual({ kind: 'skip', reason: 'invalid-output' });
    expect(await askFromCandidates(input, [valid.question], vi.fn().mockResolvedValue(output({ ...valid, candidate: 1 })))).toEqual({ kind: 'skip', reason: 'invalid-output' });
  });

  it('rescues invalid evidence with a reason-specific retry', async () => {
    const complete = vi.fn().mockResolvedValueOnce(output({ ...valid, quote: 'silver kettle' })).mockResolvedValueOnce(output(valid));
    const diagnostics = vi.fn();
    expect(await askFromCandidates(input, questions, complete, undefined, diagnostics)).toMatchObject({ kind: 'question' });
    expect(complete.mock.calls[0][1]).toHaveLength(1);
    expect(complete.mock.calls[1][1][1]).toEqual({ role: 'agent', text: output({ ...valid, quote: 'silver kettle' }) });
    expect(complete.mock.calls[1][1][2]).toMatchObject({ role: 'user', text: expect.stringContaining('uppercase/lowercase') });
    expect(diagnostics).toHaveBeenCalledWith({ attempts: 2, failures: ['evidence'], selectedIndex: 2, outcome: 'question' });
  });

  it('reports transport failure without retry', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await askFromCandidates(input, questions, complete)).toEqual({ kind: 'unavailable', retryable: true });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does not call the model after pre-cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const complete = vi.fn();
    await expect(askFromCandidates(input, questions, complete, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(['not json', output(valid)])('propagates cancellation during completion even when it returns %s', async (response) => {
    const controller = new AbortController();
    const complete = vi.fn(async () => { controller.abort(); return response; });
    await expect(askFromCandidates(input, questions, complete, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('propagates caller cancellation when transport throws', async () => {
    const controller = new AbortController();
    const complete = vi.fn(async () => { controller.abort(); throw new Error('transport aborted'); });
    await expect(askFromCandidates(input, questions, complete, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
