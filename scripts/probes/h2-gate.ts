/**
 * h2-gate.ts — hunt H2: gate predicates (excl. isGrounded=R4, isSingleQuestion
 * advice-pass=R6). Probe abbreviation false-negatives in isSingleQuestion,
 * unicode handling in contentWords (shared by copiesSeed/echoesText), and
 * multi-question smuggling.
 */
import {
  copiesSeed,
  echoesText,
  isSingleQuestion,
  isGrounded,
} from '../../src/core/gate.js';
import { TOPIC_PROBES } from '../../src/core/topic-probe.js';

const p = (label: string, v: unknown) => console.log(`${v ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(v)}`);

console.log('=== isSingleQuestion: abbreviations (single genuine question with a period abbr) ===');
p('"Is Dr. Smith coming?" (one Q, Dr. abbr)', isSingleQuestion('Is Dr. Smith coming?'));
p('"Did you see Mr. and Mrs. Jones?"', isSingleQuestion('Did you see Mr. and Mrs. Jones?'));
p('"Does the text use e.g. or i.e.?"', isSingleQuestion('Does the text use e.g. or i.e.?'));
p('"Where is St. Paul\'s cathedral?"', isSingleQuestion("Where is St. Paul's cathedral?"));
p('"Why does 3.5 matter here?"', isSingleQuestion('Why does 3.5 matter here?'));
p('"She lives on Elm St." -> "Is Elm St. far?"', isSingleQuestion('Is Elm St. far?'));

console.log('\n=== isSingleQuestion: multi-question smuggling (should FAIL) ===');
p('"Did you ask her? Or did she?" (2 Qs)', isSingleQuestion('Did you ask her? Or did she?'));
p('"What is it? What is it really?"', isSingleQuestion('What is it? What is it really?'));
p('"Why? Why now?"', isSingleQuestion('Why? Why now?'));
p('He said "why?" then what? (quoted speech exempt)', isSingleQuestion('He said "why?" then what?'));
p('"Was it "good" or "bad"?" (inner quoted words)', isSingleQuestion('Was it "good" or "bad"?'));
p('"Is it Dr.?" (abbr then Q)', isSingleQuestion('Is it Dr.?'));

console.log('\n=== isSingleQuestion: >280-char single question ===');
const longQ = 'What are the three most important structural choices you made in this passage that a reader would need explained before they could follow how the tension escalates across the scene and the stakes shift from one character to the next, and where exactly does the turning point arrive?'.repeat(1);
p(`single long Q len=${longQ.length}`, isSingleQuestion(longQ));
p('280-char-ish boundary: len=280', isSingleQuestion('x'.repeat(279) + '?'));

console.log('\n=== unicode content words (shared by copiesSeed / echoesText) ===');
// copiesSeed: question and seed sharing a unicode content word
console.log('--- copiesSeed with unicode "café" ---');
p('question mentions "café", seed has "café"', copiesSeed('What about the café in the plaza?', 'Describe the café and its patrons.'));
p('question mentions "café", seed has "cafe" (accent-free)', copiesSeed('What about the café in the plaza?', 'Describe the cafe and its patrons.'));
console.log('--- echoesText with unicode ---');
p('question bigram from unicode passage', echoesText('Does the café smell of bread?', 'The café smelled of bread this morning.'));
p('naïve/déjà: question "naïve", window "naive"', copiesSeed('How does the naïve narrator see it?', 'A naive narrator tells it.'));

console.log('\n=== isGrounded unicode cross-check (sanity; R4 area but shows tokenization) ===');
p('grounded café vs cafe (accent differs)', isGrounded('What about the café?', 'The cafe is busy.'));
p('grounded déjà vs deja', isGrounded('Déjà vu?', 'deja vu'));

console.log('\n=== TOPIC_PROBES: are all fallback questions actually questions? ===');
TOPIC_PROBES.forEach((q, i) => {
  console.log(`  [${i}] ${JSON.stringify(q)}  endsWith?=${q.trim().endsWith('?')}  isSingleQuestion=${isSingleQuestion(q)}`);
});
