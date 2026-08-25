/**
 * h2-confirm.ts — strengthen findings: (a) echoesText false-negative when the
 * model accent-normalizes a shared unicode word (window accented, question
 * plain) — the same bigram is "the café..." vs "the cafe..." and no longer
 * matches; (b) copiesSeed accent-drop escape; (c) emphatic "Why?!" rejected;
 * (d) copiesSeed runs on corrupted accent-stripped tokens.
 */
import { copiesSeed, echoesText, isSingleQuestion } from '../../src/gate.js';

console.log('=== (a) echoesText accent-asymmetry (window accented, question plain) ===');
// Near-verbatim echo, matching accents: SHOULD and DOES trip (1.0)
console.log('matching accents "The café is loud?" vs "The café is loud.":',
  echoesText('The café is loud?', 'The café is loud.'));
// Same echo, model accent-normalized: escapes (accented word fragments the bigram)
console.log('model dropped accent "The cafe is loud?" vs "The café is loud.":',
  echoesText('The cafe is loud?', 'The café is loud.'));
console.log('   (both are the same echo; second one is not flagged)');

console.log('\n=== (b) copiesSeed accent-drop escape ===');
// Seed and question share the accented word; question drops the accent.
console.log('seed "café", question "cafe" (verbatim content):',
  copiesSeed('What is the cafe in the plaza?', 'Explain the café in the plaza.'));
console.log('   (should be a near-copy; shared words compared on mangled tokens)');

console.log('\n=== (c) emphatic single question ending "?!" ===');
console.log('"Why?!"           ->', isSingleQuestion('Why?!'));
console.log('"Really?!"        ->', isSingleQuestion('Really?!'));
console.log('"How dare you?!"  ->', isSingleQuestion('How dare you?!'));

console.log('\n=== (d) contentWords corruption (sanity via copiesSeed tokens) ===');
const norm = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
console.log('"café" ->', JSON.stringify(norm('café')), '(accent-stripped to "caf")');
console.log('"déjà" ->', JSON.stringify(norm('déjà')), '(fragments "d","j" both <3 chars, VANISH)');
console.log('"fiancée" ->', JSON.stringify(norm('fiancée')), '("fianc" + "e")');
