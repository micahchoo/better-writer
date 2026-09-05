import { measureWindow } from '../../src/core/window-stats.js'

const cases: Array<[string,string]> = [
  ['possessive apostrophe', "The writers' guild met. The editors' room stayed dark. Nothing else happened at all."],
  ['no apostrophe', "The writers guild met. The editors room stayed dark. Nothing else happened at all."],
  ['inline quote mid-sentence', 'He said "hello" and then left the building without another word to anyone there.'],
]
for (const [name, text] of cases) {
  const s = measureWindow(text)
  console.log(name, '=> mean', s.values.sentenceMean.toFixed(2), 'sigma', s.values.sentenceSigma.toFixed(2))
}

console.log('\n--- adverb false positives ---')
const fp = measureWindow('The family reply was only a supply of holy folly. Italy rally ugly.')
console.log('adverbRate', fp.values.adverbRate.toFixed(1), 'axes', [...fp.axes])

console.log('\n--- passive proxy false positive ---')
const pp = measureWindow('She was tired. He was bored. They were scared. It was red.')
console.log('nominalRate', pp.values.nominalRate.toFixed(1), 'axes', [...pp.axes])
