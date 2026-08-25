import { measureWindow } from '../../web/window-stats.js'
const v = (t: string) => { const m = measureWindow(t); return m.values }
console.log('=== H1-1 filter verbs: tense sensitivity ===')
console.log('past   ', v('She felt cold. He seemed tired. They noticed it. She realized. He watched. She wondered.').filterRate.toFixed(2))
console.log('present', v('She feels cold. He seems tired. They notice it. She realizes. He watches. She wonders.').filterRate.toFixed(2))
console.log('-ing   ', v('She was feeling cold, seeming tired, noticing it, realizing, watching, wondering.').filterRate.toFixed(2))
console.log('\n=== H1-2 sentence splitter ===')
for (const [l,t] of [['titles','Mr. Darcy wrote. Mrs. Smith read. Dr. Lee slept. St. John waited.'],
                     ['no titles','Darcy wrote. Smith read. Lee slept. John waited.'],
                     ['ellipsis','He walked down the hall... then paused. She waited.'],
                     ['no ellipsis','He walked down the hall then paused. She waited.']] as [string,string][])
  console.log(l.padEnd(12), 'mean', v(t).sentenceMean.toFixed(2), 'sigma', v(t).sentenceSigma.toFixed(2))
console.log('\n=== H1-3 nominalization POS-blindness ===')
for (const t of ['She paused for a moment before answering the question.','They mention the witness and comment on the garment.','The implementation of the arrangement showed a certain hesitance.'])
  console.log(v(t).nominalRate.toFixed(2).padStart(6), t)
console.log('\n=== H1-7 dialogue across a newline ===')
console.log('wrapped  ', v('"I cannot believe\nyou did that," she said.').dialogueDensity.toFixed(3))
console.log('unwrapped', v('"I cannot believe you did that," she said.').dialogueDensity.toFixed(3))
