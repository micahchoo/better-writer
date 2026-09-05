import { isGrounded, isSingleQuestion } from '../../src/core/gate.js'
console.log('--- isGrounded prefix rule: remaining false positives? ---')
for (const [q, w] of [
 ['What does the character want?', 'The charactor sheet lists them.'],
 ['Why does she start here?', 'He started the car and the starling flew.'],
 ['What is the mother doing?', 'The moth circled.'],
 ['Which room matters?', 'He entered the roommate\'s space.'],
 ['What does the fall mean?', 'She fell and the fallout spread.'],
 ['Why the light?', 'The lightning struck.'],
] as [string,string][]) console.log(String(isGrounded(q,w)).padEnd(6), JSON.stringify(q), 'vs', JSON.stringify(w))
console.log('\n--- isGrounded: legitimate stems it now REJECTS ---')
for (const [q, w] of [
 ['What does she carry?', 'She carried the box.'],
 ['Why the knife?', 'The knives lay out.'],
 ['What about the children?', 'The child waited.'],
 ['Why running?', 'She ran hard.'],
 ['What does the writing do?', 'He wrote it down.'],
] as [string,string][]) console.log(String(isGrounded(q,w)).padEnd(6), JSON.stringify(q), 'vs', JSON.stringify(w))
console.log('\n--- isSingleQuestion: advice/commands that still pass ---')
for (const s of [
 'Rewrite the whole paragraph in second person?',
 'Cut the adverbs and let the verbs carry it, yes?',
 'Consider replacing "looked careless" with a flick of the wrist, no?',
 'Have you considered that your verbs are flat, your nouns abstract, and your narrator hedges constantly throughout this passage?',
]) console.log(String(isSingleQuestion(s)).padEnd(6), JSON.stringify(s.slice(0,80)))
