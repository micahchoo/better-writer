import { measureWindow } from '../../src/core/window-stats';
import { createCadence } from '../../web/cadence';

const fmt = (s: ReturnType<typeof measureWindow>) => ({
  axes: [...s.axes],
  dialogueDensity: +s.values.dialogueDensity.toFixed(3),
  sentenceMean: +s.values.sentenceMean.toFixed(2),
  sentenceSigma: +s.values.sentenceSigma.toFixed(2),
  longSentences: s.values.longSentences,
  adverbRate: +s.values.adverbRate.toFixed(2),
  filterRate: +s.values.filterRate.toFixed(2),
  nominalRate: +s.values.nominalRate.toFixed(2),
});

console.log('=== A) filter verbs: past-tense table vs present/inflected class ===');
const present = measureWindow(
  'He seems tired. She feels the cold. She watches the door and wonders why. He notices the change and realizes it now.',
);
const past = measureWindow(
  'He seemed tired. She felt the cold. She watched the door and wondered why. He noticed the change and realized it now.',
);
console.log('present-tense filter verbs (seems/feels/watches/wonders/notices/realizes):', fmt(present));
console.log('past-tense   filter verbs (seemed/felt/watched/wondered/noticed/realized):', fmt(past));
const ing = measureWindow(
  'I am feeling cold and watching the door, noticing the change, wondering why, realizing the truth, sensing the shift.',
);
console.log('-ing filter verbs (feeling/watching/noticing/wondering/realizing):', fmt(ing));

console.log('\n=== B) abbreviation/title-period sentence splitting ===');
const abbr = measureWindow(
  'Mr. Darcy wrote to Mrs. Bennett. Dr. Smith met St. John at the U.S. embassy. The U.K. signed, and e.g. the list continued, etc.',
);
const plain = measureWindow(
  'Mr Darcy wrote to Mrs Bennett. Dr Smith met St John at the US embassy. The UK signed, and eg the list continued, etc.',
);
console.log('with periods (Mr. Mrs. Dr. St. U.S. U.K. e.g. etc.):', fmt(abbr));
console.log('same without periods:', fmt(plain));

console.log('\n=== C) ellipsis sentence splitting ===');
const ellipsis = measureWindow(
  'He walked down the hall ... then he paused at the door. She waited silently.',
);
const ellipsisNoSpace = measureWindow(
  'He walked down the hall... then he paused at the door. She waited silently.',
);
console.log('ellipsis with surrounding spaces:', fmt(ellipsis));
console.log('ellipsis with no spaces:', fmt(ellipsisNoSpace));

console.log('\n=== D) nominalization suffix: POS-agnostic false positives ===');
const moment = measureWindow('She paused for a moment before answering the question.');
const mention = measureWindow('They mention the witness and comment on the garment.');
console.log('"moment ... question" (moment=concrete noun, question=noun):', fmt(moment));
console.log('"mention/witness/comment/garment" (mention=verb, witness=verb/noun):', fmt(mention));

console.log('\n=== E) -ly proper nouns counted as adverbs ===');
const names = measureWindow('Emily met Kelly in Sicily. They strolled along the coast.');
const clean = measureWindow('She met her friend in the town. They strolled along the coast.');
console.log('proper nouns ending -ly (Emily, Kelly, Sicily):', fmt(names));
console.log('control without names:', fmt(clean));

console.log('\n=== F) cadence counts markdown tokens as words ===');
const c = createCadence({ threshold: 8, pauseMs: 1000 });
console.log('first feed (pure markdown structure):', c.observe('', 0));
// A structure-only markdown blob with no real prose, then quiet for the pause.
const md = '## Heading\n\n**bold** and *ital* and `code`\n- item one\n- item two\n- item three\n---';
console.log('structure-only markdown, net tokens counted as words:', c.observe(md, 0));
console.log('same text, pause elapsed (fired ready?):', c.observe(md, 5000));

console.log('\n=== G) -ly adverbs of frequency excluded despite docstring rule ===');
const early = measureWindow('She arrived early. He trains daily and reviews weekly.');
console.log('early/daily/weekly (both adj and adverb, in table):', fmt(early));

console.log('\n=== H) dialogue across a line break (paragraph wrap) not counted ===');
const wrapped = measureWindow('"I cannot believe\nyou did that," she said.');
const single = measureWindow('"I cannot believe you did that," she said.');
console.log('dialogue wrapped over a newline:', fmt(wrapped));
console.log('same dialogue on one line:', fmt(single));
