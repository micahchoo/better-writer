import { measureWindow } from '../../src/core/window-stats';
import { createCadence } from '../../web/cadence';

const sentencesOf = (raw: string) => {
  // Reproduce splitSentences counting by measuring: infer sentence count via sigma/mean trick is
  // fragile; instead import nothing private — just print mean and total words.
  const s = measureWindow(raw);
  return {
    mean: +s.values.sentenceMean.toFixed(2),
    sigma: +s.values.sentenceSigma.toFixed(2),
    long: s.values.longSentences,
    axes: [...s.axes],
  };
};

console.log('=== B2) sentence count distortion (words / mean => sentences) ===');
const abbrRaw = 'Mr. Darcy wrote. Mrs. Smith read. Dr. Lee slept. St. John waited.';
const plainRaw = 'Mr Darcy wrote. Mrs Smith read. Dr Lee slept. St John waited.';
const a = measureWindow(abbrRaw);
const p = measureWindow(plainRaw);
console.log('abbr raw total words:', abbrRaw.match(/[A-Za-z][A-Za-z'-]*/g)?.length, 'sentences:', 4, '-> measured mean', a.values.sentenceMean);
console.log('with  periods:', JSON.stringify(sentencesOf(abbrRaw)));
console.log('without periods:', JSON.stringify(sentencesOf(plainRaw)));

console.log('\n=== C2) ellipsis: spurious sentence boundary count ===');
const el = 'He walked down the hall... then paused. She waited.';
const noEl = 'He walked down the hall and paused. She waited.';
console.log('ellipsis  :', JSON.stringify(sentencesOf(el)));
console.log('no ellipsis:', JSON.stringify(sentencesOf(noEl)));

console.log('\n=== E2) more -ly proper nouns + table membership ===');
for (const name of ['Emily', 'Kelly', 'Wally', 'Bailey', 'Sicily', 'Tully', 'Shelly', 'Riley']) {
  const s = measureWindow(`${name} left the room and sat by the window.`);
  console.log(`${name.padEnd(8)} adverbRate=${s.values.adverbRate.toFixed(1).padStart(5)} axes=[${[...s.axes]}]`);
}

console.log('\n=== G2) frequency adverbs in table (both adjective and adverb) ===');
const freq = measureWindow('She arrives early. He trains daily. We meet weekly, monthly, and yearly. Rent is due hourly. The guard checks nightly.');
console.log(JSON.stringify(freq.values), 'axes=[', [...freq.axes], ']');
console.log('note: "kindly" (docstring example kept) DOES count:', measureWindow('He kindly agreed.').values.adverbRate);

console.log('\n=== F2) cadence with DEFAULT threshold (30) on markdown-structure-only doc ===');
const c2 = createCadence(); // default threshold 30, pause 20s
const structureOnly = [
  '# Report',
  '',
  '## Section One',
  '- bullet one',
  '- bullet two',
  '- bullet three',
  '- bullet four',
  '',
  '## Section Two',
  '- alpha',
  '- beta',
  '- gamma',
  '- delta',
  '',
  '```',
  'const x = 1;',
  'const y = 2;',
  'const z = 3;',
  '```',
  '',
  '---',
  '',
  '## Section Three',
  '- item a',
  '- item b',
  '- item c',
  '- item d',
  '- item e',
].join('\n');
// real prose word count (strip markdown) vs raw token count
const realWords = structureOnly.replace(/```[\s\S]*?```/g, ' ').replace(/^#{1,6}\s.*$/gm, ' ').replace(/^\s*[-+*]\s+/gm, ' ').replace(/[*_~`]/g, ' ').split(/\s+/).filter(Boolean).length;
const rawTokens = structureOnly.split(/\s+/).filter(Boolean).length;
console.log('real prose words:', realWords, '| raw whitespace tokens:', rawTokens);
console.log('observe empty:', c2.observe('', 0));
console.log('observe structure-only @0ms:', c2.observe(structureOnly, 0));
console.log('observe same @30s (pause elapsed):', c2.observe(structureOnly, 30_000));

console.log('\n=== I) empty / punctuation-only windows: NaN check ===');
for (const w of ['', '   ', '###', '...', '!!!', '** **', '``` ```']) {
  const s = measureWindow(w);
  const vals = Object.values(s.values);
  const anyNaN = vals.some((v) => Number.isNaN(v));
  console.log(JSON.stringify(w), 'NaN?', anyNaN, 'values=', JSON.stringify(s.values));
}
