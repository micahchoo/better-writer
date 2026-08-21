import { describe, expect, it } from 'vitest';
import { isSingleQuestion } from './gate.js';

describe('isSingleQuestion', () => {
 it('accepts a single clean question', () => {
  expect(isSingleQuestion('What is actually at stake here?')).toBe(true);
  expect(isSingleQuestion('What does the speaker want here, and what stands in the way?')).toBe(true);
  expect(isSingleQuestion('Say in one plain sentence what this passage is really about.')).toBe(false);
 });

 it('rejects a chatty preamble that trails after the question', () => {
  // The gate is syntactic — it cannot read intent — so a preamble is rejected
  // when it carries the extra content the rules catch (here: trailing text).
  expect(isSingleQuestion('Nice paragraph — have you considered what the door symbolizes? Let me know.')).toBe(false);
 });

 it('rejects list-marked output', () => {
  expect(isSingleQuestion('- What is at stake here?')).toBe(false);
  expect(isSingleQuestion('* What is at stake here?')).toBe(false);
  expect(isSingleQuestion('• What is at stake here?')).toBe(false);
  expect(isSingleQuestion('1. What is at stake here?')).toBe(false);
  expect(isSingleQuestion('12. What is at stake here?')).toBe(false);
 });

 it('rejects multi-sentence output', () => {
  expect(isSingleQuestion('What is at stake here? What changed?')).toBe(false);
  expect(isSingleQuestion('What is at stake here? Let me explain.')).toBe(false);
 });

 it('rejects output with no question mark', () => {
  expect(isSingleQuestion('What is at stake here')).toBe(false);
  expect(isSingleQuestion('Consider what is at stake.')).toBe(false);
 });

 it('rejects empty or whitespace-only output', () => {
  expect(isSingleQuestion('')).toBe(false);
  expect(isSingleQuestion('   ')).toBe(false);
 });

 it('rejects trailing text after the final question mark', () => {
  expect(isSingleQuestion('What is at stake here? Thanks!')).toBe(false);
  expect(isSingleQuestion('What is at stake here? Hope that helps.')).toBe(false);
 });

 it('rejects multi-line output', () => {
  expect(isSingleQuestion('What is at stake here?\nWhat changed?')).toBe(false);
  expect(isSingleQuestion('Here is my question:\nWhat is at stake here?')).toBe(false);
 });

 it('allows trailing whitespace after the question mark', () => {
  expect(isSingleQuestion('What is at stake here?  ')).toBe(true);
  expect(isSingleQuestion('What is at stake here?\t')).toBe(true);
 });

 it('rejects a question with a second question mark anywhere', () => {
  expect(isSingleQuestion('What is at stake? Really?')).toBe(false);
  expect(isSingleQuestion('What is at stake here???')).toBe(false);
 });
});
