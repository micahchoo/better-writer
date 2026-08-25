import { staleAnnotations, reconcileAnnotations } from '../../web/coach-sweep.js'

const A = (start: number, end: number, fragment: string) => ({ start, end, fragment })
const show = (label: string, notes: any[], draft: string) => {
  const { valid, changed } = reconcileAnnotations(notes, draft)
  console.log(`${label}\n   in ${notes.length} -> out ${valid.length}, changed=${changed}`)
  valid.forEach(v => console.log(`      [${v.start},${v.end}) ${JSON.stringify(v.fragment)} == ${JSON.stringify(draft.slice(v.start,v.end))} ${draft.slice(v.start,v.end)===v.fragment?'':'  <-- MISMATCH'}`))
}

const draft = 'The cat sat on the mat. The dog sat on the log.'
show('1. exact hit', [A(4, 7, 'cat')], draft)
show('2. text inserted before (offsets shift)', [A(4, 7, 'cat')], 'PREFIX. ' + draft)
show('3. two equidistant occurrences -> dropped', [A(10, 13, 'sat')], draft)
show('4. fragment gone', [A(4, 7, 'cat')], 'The dog sat on the log.')

console.log('\n--- the interesting one: a fragment that still matches at its old offsets BY ACCIDENT ---')
// The writer deletes "cat " and the old span now covers different, equal text.
const before = 'aaa cat bbb cat ccc'
const after  = 'aaa cat cat ccc'          // one "bbb " deleted
show('5. accidental match at old offsets', [A(12, 15, 'cat')], after)
console.log('   (note 5 was pinned to the SECOND cat at [12,15) in', JSON.stringify(before) + ')')
console.log('   after the edit, [12,15) is', JSON.stringify(after.slice(12,15)), '- kept silently')

console.log('\n--- empty fragment ---')
show('6. empty fragment', [A(0, 0, '')], draft)

console.log('\n--- fragment appearing 3x, old pos nearest the middle one ---')
const d3 = 'sat ... sat ... sat'
show('7. three occurrences', [A(8, 11, 'sat')], d3)

console.log('\n--- reconcile identity: does an untouched note keep its object identity? ---')
const n = A(4, 7, 'cat')
const r = reconcileAnnotations([n], draft)
console.log('   same object reference:', r.valid[0] === n, '| changed:', r.changed)
