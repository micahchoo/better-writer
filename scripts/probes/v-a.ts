import { extractAnchor } from '../../web/anchor.js'
import { measureWindow } from '../../src/core/window-stats.js'

console.log('=== H3-1: U+0130 offsets ===')
for (const [label, draft, q] of [
 ['initial-I-dot', 'She went to İstanbul yesterday.', 'why istanbul?'],
 ['I-dot at doc end', 'about İstanbul', 'why istanbul?'],
 ['I-dot prefix in token', 'aaa bbb İtyped ccc', 'why typed?'],
] as [string,string,string][]) {
 const a = extractAnchor(q, draft, 0)
 if (!a) { console.log(label.padEnd(22), 'null'); continue }
 const oob = a.end > draft.length || a.match.end > draft.length
 console.log(label.padEnd(22), `anchor=[${a.start},${a.end}) match=[${a.match.start},${a.match.end})`,
   `matchSlice=${JSON.stringify(draft.slice(a.match.start,a.match.end))}`, oob ? 'OUT OF DOC' : '')
}

console.log('\n=== H1-4: names ending in -ly ===')
for (const n of ['Emily','Kelly','Wally','Sicily','Tully','Shelly','Beverly','Kimberly']) {
 const s = measureWindow(`${n} left the room without saying one word to him`)
 console.log(n.padEnd(10), 'adverbRate', s.values.adverbRate.toFixed(1), 'axes', JSON.stringify([...s.axes]))
}
console.log('control  ', 'adverbRate', measureWindow('She left the room without saying one word to him').values.adverbRate.toFixed(1))

console.log('\n=== H1-6: frequency -ly adverbs vs the docstring ===')
console.log('frequency ', measureWindow('She arrives early. He trains daily. They meet weekly.').values.adverbRate.toFixed(1))
console.log('kindly    ', measureWindow('He kindly agreed to wait for her.').values.adverbRate.toFixed(1))
