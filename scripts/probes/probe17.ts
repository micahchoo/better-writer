import { buildHighlightSet } from '../../web/decorations.js'
import { noteId } from '../../web/notes.js'

const tries: Array<[string, any[]]> = [
  ['undefined offsets (what a corrupt localStorage yields)', [{ start: undefined, end: undefined, tone: 'note' }]],
  ['string offsets', [{ start: '5', end: '9', tone: 'note' }]],
  ['NaN offsets', [{ start: NaN, end: NaN, tone: 'note' }]],
  ['negative / reversed', [{ start: 9, end: 4, tone: 'note' }]],
  ['tone with a quote (class injection)', [{ start: 0, end: 3, tone: 'x" onmouseover="alert(1)' }]],
]
for (const [label, spans] of tries) {
  try {
    const set = buildHighlightSet(spans as any, 20)
    console.log(`ok     ${label} -> size ${set.size}`)
  } catch (e) {
    console.log(`THROWS ${label} -> ${(e as Error).message}`)
  }
}

console.log('\nnoteId on a corrupt note:', JSON.stringify(noteId({ start: undefined, end: undefined, ts: undefined } as any)))
