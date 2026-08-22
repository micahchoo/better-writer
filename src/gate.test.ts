import { describe, expect, it } from 'vitest';
import {
 copiesSeed,
 echoesText,
 isGrounded,
 isSingleQuestion,
} from './gate.js';

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

describe('isGrounded', () => {
 const seedDump =
  'If your character is apprehensive about an unwanted confrontation, hold it off as long as possible.';
 const dumpWindow =
  '(2026) AI video has completely transcended into the canny valley, the instagrams cannot believe that the video of Korean women walking around tending to cats is fully AI.';
 const restatementWindow =
  'The new paradigm represents a fundamental shift in how we understand the relationship between technology and humanity in the contemporary moment.';
 const restatementQuestion =
  'Does the new paradigm represent a fundamental shift in how we understand the relationship between technology and humanity in the contemporary moment?';
 const groundedWindow =
  'She walked to the store. She bought milk. She came home.';
 const groundedQuestion =
  'How do you slow down the walk to the store so the reader feels the texture of the air on her skin and hears the pavement under her feet?';
 const policyWindow =
  'In my own personal opinion, I truly believe that the very first time that I ever saw the ocean, it was, honestly speaking, an experience that was quite literally unforgettable in every possible way.';

 it('rejects a verbatim seed dump that shares nothing with the window', () => {
  expect(isGrounded(seedDump, dumpWindow)).toBe(false);
 });

 it('accepts a restatement-style question because it reuses window words', () => {
  expect(isGrounded(restatementQuestion, restatementWindow)).toBe(true);
 });

 it('accepts a legitimate question grounded in the window', () => {
  expect(isGrounded(groundedQuestion, groundedWindow)).toBe(true);
 });

 it('accepts a short grounded question via a single shared word', () => {
  expect(
   isGrounded('What past memory should she dwell on before buying milk?', groundedWindow),
  ).toBe(true);
 });

 it('rejects a question that references no actual window words', () => {
  expect(
   isGrounded(
    'How does the length of your sentences affect the rhythm of this passage?',
    policyWindow,
   ),
  ).toBe(false);
 });

 it('matches substrings in both directions, case-insensitively', () => {
  // Question word contained in a window word: "walk" in "WALKED".
  expect(isGrounded('How does the WALK feel?', 'She WALKED to the store.')).toBe(true);
  // Window word contained in a question word: "store" in "storekeeper".
  expect(isGrounded('Where did the storekeeper go?', 'She walked to the store.')).toBe(true);
 });

 it('never matches via a short token inside a longer one', () => {
  expect(isGrounded('Where is she going?', 'She walked to the store.')).toBe(false);
  expect(isGrounded('Cat?', 'The cat sat.')).toBe(false);
 });

 it('returns false for an empty question, empty window, or stopword-only input', () => {
  expect(isGrounded('', 'She walked to the store.')).toBe(false);
  expect(isGrounded('What is at stake here?', '')).toBe(false);
  expect(isGrounded('The and of or', 'She walked to the store.')).toBe(false);
  expect(isGrounded('What is at stake here?', 'the and of or')).toBe(false);
 });

 it('handles a single-token window', () => {
  expect(isGrounded('What about the milk?', 'Milk.')).toBe(true);
  expect(isGrounded('What about the walk?', 'Milk.')).toBe(false);
 });
});

describe('echoesText', () => {
 const restatementWindow =
  'The new paradigm represents a fundamental shift in how we understand the relationship between technology and humanity in the contemporary moment.';
 const restatementQuestion =
  'Does the new paradigm represent a fundamental shift in how we understand the relationship between technology and humanity in the contemporary moment?';
 const groundedWindow =
  'She walked to the store. She bought milk. She came home.';
 const groundedQuestion =
  'How do you slow down the walk to the store so the reader feels the texture of the air on her skin and hears the pavement under her feet?';
 const dumpWindow =
  '(2026) AI video has completely transcended into the canny valley, the instagrams cannot believe that the video of Korean women walking around tending to cats is fully AI.';
 const seedDump =
  'If your character is apprehensive about an unwanted confrontation, hold it off as long as possible.';

 it('flags a restatement of the window as a question', () => {
  expect(echoesText(restatementQuestion, restatementWindow)).toBe(true);
 });

 it('does not flag a legitimate question about the window', () => {
  expect(echoesText(groundedQuestion, groundedWindow)).toBe(false);
  expect(
   echoesText('What past memory should she dwell on before buying milk?', groundedWindow),
  ).toBe(false);
 });

 it('does not flag a seed dump whose text never appears in the window', () => {
  expect(echoesText(seedDump, dumpWindow)).toBe(false);
 });

 it('flags a near-exact echo of the window', () => {
  expect(echoesText('She walked to the store and bought milk?', 'She walked to the store. She bought milk.')).toBe(true);
 });

 it('requires more than half of the question bigrams to match', () => {
  // Exactly half (2 of 4) is not enough.
  expect(echoesText('a b c x y', 'a b c d')).toBe(false);
 });

 it('returns false for empty or single-token inputs', () => {
  expect(echoesText('', 'She walked to the store.')).toBe(false);
  expect(echoesText('What?', '')).toBe(false);
  expect(echoesText('Milk?', 'Milk.')).toBe(false);
 });

 describe('cursor envelope retargeting', () => {
  // A long multi-paragraph draft with the cursor block marked in the middle.
  const fillerBefore =
   'Fog rolled off the harbor before dawn, thick enough to swallow the promenade lamps whole. The town had been shrinking for a decade, ever since the cannery closed and the young people followed the work inland. What remained were the old houses, the salt-worn pier, and the weekly ferry that now carried mostly mail and medicine.';
  const fillerAbove =
   'Each morning the postmistress sorted the letters by hand, her fingers moving through the envelopes the way her mother had taught her, and she noted which names appeared less often than the winter before. Nobody said the word abandonment, but it hung in the air like the damp.';
  const markedParagraph =
   'The old lighthouse keeper still checks the lamps every night even though the ships no longer come.';
  const fillerBelow =
   'On the headland the lighthouse stood idle through the afternoons, its beam switched off, its brass fittings polished out of habit. The post had passed from father to son, and a morning without the climb up the spiral stairs to check the glass and the fuel was unthinkable.';
  const fillerAfter =
   'Visitors from the city sometimes asked why the light still turned at dusk, and the keeper would shrug and say that a lamp is a promise a town makes to the sea. The question of whether anyone needed the light anymore felt almost rude, like asking an old musician why he still tunes the piano.';
  const markedWindow = [
   fillerBefore,
   fillerAbove,
   `[CURSOR START]\n${markedParagraph}\n[CURSOR END]`,
   fillerBelow,
   fillerAfter,
  ].join('\n\n');
  const markerlessWindow = [
   fillerBefore,
   fillerAbove,
   markedParagraph,
   fillerBelow,
   fillerAfter,
  ].join('\n\n');
  const restatement =
   'Does the old lighthouse keeper still check the lamps every night even though the ships no longer come?';
  const groundedQuestion =
   'Why does the keeper light the lamps every night when the ships have gone?';

  it('catches a restatement of the marked paragraph inside a large marked window', () => {
   // The silent-breakage fix: the envelope keeps the echo check firing even
   // though the window is now the whole draft.
   expect(echoesText(restatement, markedWindow)).toBe(true);
  });

  it('catches the same restatement in a marker-less window, as before', () => {
   expect(echoesText(restatement, markerlessWindow)).toBe(true);
  });

  it('does not flag a grounded non-echo question about the marked paragraph', () => {
   // Only 4 of the question's 13 bigrams sit in the envelope — no false
   // positive on the retargeted check.
   expect(echoesText(groundedQuestion, markedWindow)).toBe(false);
  });
 });
});

describe('copiesSeed', () => {
 const seedDump =
  'If your character is apprehensive about an unwanted confrontation, hold it off as long as possible.';
 const groundedSeed =
  "To stretch a moment that took only seconds, heighten the character's perception of physical stimuli and let the language slow down.";
 const groundedQuestion =
  'How do you slow down the walk to the store so the reader feels the texture of the air on her skin and hears the pavement under her feet?';

 it('flags a verbatim seed dump', () => {
  expect(copiesSeed(seedDump, seedDump)).toBe(true);
 });

 it('does not flag a legitimate question that reuses at most one seed word', () => {
  expect(copiesSeed(groundedQuestion, groundedSeed)).toBe(false);
 });

 it('requires a strict majority of content words to come from the seed', () => {
  const seed = 'walk store reader feels';
  // 2 of 3 question content words come from the seed.
  expect(copiesSeed('How does the walk feel in the store?', seed)).toBe(true);
  // Exactly half (2 of 4) is not enough.
  expect(copiesSeed('walk store question word?', seed)).toBe(false);
 });

 it('matches exactly, ignoring case and punctuation', () => {
  expect(copiesSeed('Walk, store!', 'walk store')).toBe(true);
  // "walks" is not an exact match for "walk".
  expect(copiesSeed('Walks store', 'walk store')).toBe(false);
 });

 it('returns false for an empty seed or an empty question', () => {
  expect(copiesSeed('What is at stake here?', '')).toBe(false);
  expect(copiesSeed('', 'walk store reader feels')).toBe(false);
 });
});
