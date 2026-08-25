// runSweep: when ONE ask throws, does the sibling worker keep sweeping the
// rest of the plan and keep emitting notes after runSweep already rejected?
import { runSweep, planSweep } from '../../web/coach-sweep.js'

const draft = Array.from({ length: 18 }, (_, i) =>
  `Paragraph number ${i} where the marmoset considered its options carefully and at length.`).join('\n\n')
const plan = planSweep(draft)
console.log('plan windows:', plan.length)

let n = 0
const asked: number[] = []
const coach = {
  ask: async (w: string) => {
    const i = ++n
    asked.push(i)
    await new Promise((r) => setTimeout(r, 10))
    if (i === 1) throw new Error('server down')
    return 'What did the marmoset consider here?'
  },
}
const notesAfter: string[] = []
let sweepEnded = false
try {
  await runSweep(plan, { genre: 'fiction', coach, draft, onNote: () => {
    notesAfter.push(sweepEnded ? 'AFTER-SWEEP-ENDED' : 'during')
  } })
} catch (e) {
  console.log('runSweep rejected:', (e as Error).message)
}
sweepEnded = true
await new Promise((r) => setTimeout(r, 500))
console.log('total asks issued:', n, 'of a', plan.length, '-window plan')
console.log('notes emitted:', notesAfter)
