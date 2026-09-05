import { describe, expect, it } from 'vitest';
import { parseCoachInput, parseCoachResult } from './contract.js';
import type { CoachInput } from './types.js';
const input: CoachInput = { textWindow: 'A copper kettle waits', genre: 'fiction', cursorOffset: 200, focus: { start: 2, end: 15 } };
const question = { kind: 'question', source: 'reshaped', question: 'What do you want the copper kettle to suggest?', evidence: { quote: 'copper kettle', start: 2, end: 15 } };

describe('coaching wire contract', () => {
  it('accepts absolute cursor offsets while bounding relative focus offsets', () => {
    expect(parseCoachInput(input)).toEqual(input);
    expect(parseCoachInput({ ...input, focus: { start: 0, end: 200 } })).toBeNull();
  });
  it.each([
    { genre: 'unknown' }, { cursorOffset: -1 }, { cursorOffset: 1.2 },
    { focus: { start: 5, end: 5 } }, { focus: { start: -1, end: 4 } },
    { position: { sectionBlockCount: 2, blockIndexInSection: 2 } },
  ])('rejects invalid input fields %j', (override) => {
    expect(parseCoachInput({ ...input, ...override })).toBeNull();
  });
  it('strips unrelated input fields', () => {
    expect(parseCoachInput({ ...input, source: 'private' })).toEqual(input);
  });
  it('preserves validated question evidence and all non-question outcomes', () => {
    expect(parseCoachResult(question, input)).toEqual(question);
    for (const result of [{ kind: 'skip', reason: 'no-fit' }, { kind: 'skip', reason: 'invalid-output' }, { kind: 'unavailable', retryable: true }]) {
      expect(parseCoachResult(result, input)).toEqual(result);
    }
  });
  it.each([
    { source: 'seed' }, { question: 'Change it. Why?' },
    { evidence: { quote: 'copper kettle', start: 3, end: 16 } },
    { evidence: { quote: 'A', start: 0, end: 1 } },
    { evidence: { quote: 'silver kettle', start: 2, end: 15 } },
  ])('rejects untrustworthy question data %j', (override) => {
    expect(parseCoachResult({ ...question, ...override }, input)).toEqual({ kind: 'unavailable', retryable: false });
  });
});
