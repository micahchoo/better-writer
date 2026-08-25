import { measureWindow } from '../../web/window-stats.js'
const r = (t: string) => { const m = measureWindow(t); return `adverbRate ${m.values.adverbRate.toFixed(1)} nominalRate ${m.values.nominalRate.toFixed(1)} axes ${JSON.stringify([...m.axes])}` }
for (const [label, text] of [
 ['adjectives in -ly (fiction)', 'She was lonely. The lovely garden felt friendly. A deadly quiet. It was likely costly.'],
 ['nouns in -ly', 'The assembly met. He felt melancholy. An anomaly appeared. The monopoly grew.'],
 ['verbs in -ly', 'They rely on it. Numbers multiply. Bees comply. We supply pressure.'],
 ['genuine adverbs', 'She quickly walked. He slowly turned. It suddenly stopped. They quietly left.'],
 ['stative -ed NOT in table', 'She was ashamed. He was determined. They were convinced.'],
 ['adjectival -ed', 'The door was locked. The sky was clouded. His voice was strained.'],
 ['genuine passive', 'The window was broken by the storm. The letters were burned.'],
] as [string,string][]) console.log(label.padEnd(28), r(text))

console.log('\n--- R3: passive with an explicit marker ---')
for (const [label, text] of [
 ['regular participle + by', 'The window was destroyed by the storm.'],
 ['irregular -en + by', 'The window was broken by the storm.'],
 ['adverb between', 'The vase was quietly removed by the maid.'],
 ['progressive passive', 'The bridge was being rebuilt.'],
 ['NOT a participle before by', 'He was often by the window.'],
 ['predicate adjective', 'She was tired by then.'],
 ['agentless passive (known cost)', 'The letters were burned.'],
] as [string,string][]) {
 const m = measureWindow(text)
 console.log(label.padEnd(32), 'nominalRate', m.values.nominalRate.toFixed(1))
}
