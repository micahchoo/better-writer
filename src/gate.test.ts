import { describe, expect, it } from 'vitest';
import {
 copiesSeed,
 echoesText,
 isGrounded,
 isSingleQuestion,
} from './core/gate.js';

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

it('rejects a SECOND question, but not emphatic punctuation on one', () => {
 // Two questions: the first `?` is a real sentence end.
 expect(isSingleQuestion('What is at stake? Really?')).toBe(false);
 // One question with an emphatic terminal cluster — the same rule that lets
 // "Why?!" through (H2-1). Rejecting it would spend the retry and hand the
 // writer a fixed topic probe instead of their own question.
 expect(isSingleQuestion('What is at stake here???')).toBe(true);
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

 it('matches an inflection of the same word, case-insensitively', () => {
  // Question word is the base of a window word: "walk" / "WALKED".
  expect(isGrounded('How does the WALK feel?', 'She WALKED to the store.')).toBe(true);
  // A COMPOUND is a different word, not an inflection: "storekeeper" shares
  // no stem with "store", the same way "roommate" shares none with "room".
  expect(isGrounded('Where did the storekeeper go?', 'She walked to the store.')).toBe(false);
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

describe('isSingleQuestion — output gate (S1-0)', () => {
 const essay =
  'The passage works because of the contrast between weight and ease. '.repeat(40) +
  'What does the skillet weigh?';

 it('rejects a rewrite of the writer sentence handed back as a question', () => {
  expect(
   isSingleQuestion(
    'Try this instead: "She lifted the skillet by the wrist, a flick so offhand the iron seemed to weigh nothing at all." Does that land better for you?',
   ),
  ).toBe(false);
 });

 it('rejects advice followed by a question', () => {
  expect(
   isSingleQuestion(
    'Your verbs are doing too little here. Cut "looked careless" and let the flick carry it; adverbs like this dilute a strong image. What would the skillet feel like to her wrist?',
   ),
  ).toBe(false);
 });

 it('rejects a long essay that ends in a question', () => {
  expect(essay.length).toBeGreaterThan(280);
  expect(isSingleQuestion(essay)).toBe(false);
 });

 it('accepts a legitimate single-question one-liner', () => {
  expect(isSingleQuestion('What does the heavy iron skillet weigh in her wrist?')).toBe(true);
 });
});

describe('isSingleQuestion — quotes, lists, decor, fullwidth (S3-13)', () => {
 it('accepts a question that quotes the writer question mark', () => {
  expect(isSingleQuestion('You wrote "why?" — what does she mean?')).toBe(true);
  expect(isSingleQuestion('You wrote “why?” — what does she mean?')).toBe(true);
  expect(isSingleQuestion('Vous avez écrit «pourquoi ?» — que veut-elle dire ?')).toBe(true);
  expect(isSingleQuestion('You wrote "why？" — what does she mean?')).toBe(true);
 });

 it('does not mistake an apostrophe for a quote', () => {
  expect(isSingleQuestion("Why didn't she come?")).toBe(true);
 });

 it('treats a fullwidth ？ as equivalent to ?', () => {
  expect(isSingleQuestion('What is at stake？')).toBe(true);
  expect(isSingleQuestion('What is at stake？ What changed？')).toBe(false);
 });

 it('rejects em-dash, en-dash, and plus bullets', () => {
  expect(isSingleQuestion('— Which verb is doing the work?')).toBe(false);
  expect(isSingleQuestion('– Which verb is doing the work?')).toBe(false);
  expect(isSingleQuestion('+ What is at stake?')).toBe(false);
 });

 it('strips leading quotes and decor before the list check', () => {
  expect(isSingleQuestion('"1. What is at stake?')).toBe(false);
  expect(isSingleQuestion('**- Which detail carries the weight?**')).toBe(false);
  expect(isSingleQuestion('\t- What is at stake?')).toBe(false);
 });

 it('keeps rejecting a bare bullet (a * followed by a space)', () => {
  expect(isSingleQuestion('* What is at stake here?')).toBe(false);
 });
});

describe('isGrounded — substring quality (S2-12)', () => {
 it('rejects an internal substring match inside an unrelated word', () => {
  expect(isGrounded('What time is it?', 'He sometimes hesitates.')).toBe(false);
  expect(isGrounded('Does the reader know?', 'She had already gone.')).toBe(false);
 });

 it('rejects a suffix-only overlap', () => {
  expect(isGrounded('Which ring matters?', 'During the walk he did bring it.')).toBe(false);
 });

 it('keeps rejecting short tokens inside longer words and stopword pairs', () => {
  expect(isGrounded('Where is she going?', 'She walked to the store.')).toBe(false);
  expect(isGrounded('What other thing?', 'My brother left.')).toBe(false);
 });

 it('still grounds on a genuine shared stem', () => {
  expect(isGrounded('Why walk here?', 'She walked home.')).toBe(true);
 });
});

/**
 * R4: the prefix rule that replaced the substring rule still grounded on
 * accident whenever the accident sat at the FRONT of the longer word, and it
 * dropped every inflection that changes a letter. Stem comparison is the
 * contract now; these cases are the class, not the four words a probe printed.
 */
describe('isGrounded — stem comparison (R4)', () => {
 it('rejects a coincidental prefix, which the old rule accepted', () => {
  expect(isGrounded('What is the mother doing?', 'The moth circled.')).toBe(false);
  expect(isGrounded('Which room matters?', "He entered the roommate's space.")).toBe(false);
  expect(isGrounded('What does the fall mean?', 'She fell and the fallout spread.')).toBe(false);
  expect(isGrounded('Why the light?', 'The lightning struck.')).toBe(false);
 });

 it('keeps rejecting an internal or suffix substring, as the prefix rule did', () => {
  expect(isGrounded('What time is it?', 'He sometimes hesitates.')).toBe(false);
  expect(isGrounded('Which ring matters?', 'During the walk he did bring it.')).toBe(false);
 });

 it('grounds an inflection that changes a letter, which the old rule dropped', () => {
  // y -> i: the commonest inflection in English prose.
  expect(isGrounded('What does she carry?', 'She carried the box.')).toBe(true);
  expect(isGrounded('Whose story is this?', 'The stories repeat.')).toBe(true);
  // Doubled final consonant.
  expect(isGrounded('Why stop here?', 'He stopped at the door.')).toBe(true);
  // Silent -e.
  expect(isGrounded('What does she store?', 'She stored the jars.')).toBe(true);
  // -ing against a 3-letter base, which the old 4-char floor could not reach.
  expect(isGrounded('Why running?', 'She was running hard.')).toBe(true);
 });

 it('leaves irregular forms unmatched, the accepted cost of a light stemmer', () => {
  expect(isGrounded('Why running?', 'She ran hard.')).toBe(false);
  expect(isGrounded('Why the knife?', 'The knives lay out.')).toBe(false);
 });
});

/**
 * H2-1/H2-2: two recall defects in the gate's syntax predicates. A rejected
 * output is not free — it spends the single retry and hands the writer a
 * fixed topic probe instead of a question about their own sentence.
 */
describe('isSingleQuestion — abbreviations, decimals, emphatic ends (H2-1)', () => {
 it('accepts a genuine question containing an abbreviation', () => {
  expect(isSingleQuestion('Is Dr. Smith coming?')).toBe(true);
  expect(isSingleQuestion('Did you see Mr. and Mrs. Jones?')).toBe(true);
  expect(isSingleQuestion("Where is St. Paul's cathedral?")).toBe(true);
  expect(isSingleQuestion('Does the text use e.g. or i.e.?')).toBe(true);
 });

 it('accepts a decimal inside a question', () => {
  expect(isSingleQuestion('Why does 3.5 matter here?')).toBe(true);
 });

 it('accepts an emphatic terminal cluster containing a question mark', () => {
  expect(isSingleQuestion('Why?!')).toBe(true);
  expect(isSingleQuestion('How dare you?!')).toBe(true);
 });

 it('still rejects a cluster with no question mark at all', () => {
  expect(isSingleQuestion('Cut that line!')).toBe(false);
  expect(isSingleQuestion('Really!!')).toBe(false);
 });

 it('keeps rejecting two sentences, including after an abbreviation', () => {
  expect(isSingleQuestion('Look at this. What do you mean?')).toBe(false);
  expect(isSingleQuestion('Did you ask her? Or did she?')).toBe(false);
  // "etc" and "no" are deliberately NOT exempt: they routinely end sentences.
  expect(isSingleQuestion('She said no. What now?')).toBe(false);
  expect(isSingleQuestion('Cut the adverbs, etc. What else?')).toBe(false);
 });
});

describe('gate predicates fold accents before comparing (H2-2)', () => {
 it('catches an echo that normalizes the accent away', () => {
  expect(echoesText('The cafe is loud?', 'The café is loud.')).toBe(true);
 });

 it('catches a near-copy of the seed that drops the accent', () => {
  expect(copiesSeed('cafe in the plaza', 'café in the plaza')).toBe(true);
 });

 it('grounds an accented word against itself', () => {
  expect(isGrounded('What about the café?', 'The café was loud.')).toBe(true);
  expect(isGrounded('Why déjà vu?', 'She felt déjà vu.')).toBe(true);
 });

 it('does not ground unrelated words that merely share ASCII letters', () => {
  expect(isGrounded('What about the fiancée?', 'The cafe was loud.')).toBe(false);
 });
});
