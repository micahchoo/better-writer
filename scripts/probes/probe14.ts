import { reshape } from '../../src/core/reshape.js'
import type { Complete } from '../../src/core/types.js'
import { CURSOR_START, CURSOR_END } from '../../src/core/text-window.js'

const win = `My grandmother cooked with her wrists, not her hands.\n\n${CURSOR_START}\nShe lifted the heavy iron skillet with a flick that looked careless and set it on the burner as if it weighed nothing.\n${CURSOR_END}\n\nThe kitchen smelled of scorched butter.`
const seed = 'Check whether a physical detail earns its place in the scene.'

// A model that does exactly what the README says it cannot: writes prose for
// the writer, then tacks a question on the end.
const cases: Array<[string, string]> = [
  ['REWRITES THE WRITER\'S SENTENCE',
   `Try this instead: "She lifted the skillet by the wrist, a flick so offhand the iron seemed to weigh nothing at all." Does that land better for you?`],
  ['GIVES ADVICE THEN ASKS',
   `Your verbs are doing too little here. Cut "looked careless" and let the flick carry it; adverbs like this dilute a strong image. What would the skillet feel like to her wrist?`],
  ['LONG ESSAY THEN ASKS',
   'The passage works because of the contrast between weight and ease. ' .repeat(40) + 'What does the skillet weigh?'],
  ['LEGITIMATE ONE-LINER',
   'What does the heavy iron skillet weigh in her wrist?'],
]

for (const [label, output] of cases) {
  const complete: Complete = async () => output
  const r = await reshape(seed, win, complete)
  const shown = r.question.length > 90 ? r.question.slice(0, 90) + `… (${r.question.length} chars)` : r.question
  console.log(`${r.source === 'reshaped' ? 'PASSED GATE' : 'blocked    '} [${label}]`)
  console.log(`             -> ${shown}\n`)
}
