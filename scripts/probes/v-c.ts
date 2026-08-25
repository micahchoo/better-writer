import { isSingleQuestion, isGrounded, echoesText, copiesSeed } from '../../src/gate.js'
console.log('=== H2-1: genuine questions the gate rejects ===')
for (const q of ['Is Dr. Smith coming?','Did you see Mr. and Mrs. Jones?','Why does 3.5 matter here?',
                 "Where is St. Paul's cathedral?",'Does the text use e.g. or i.e.?','Why?!','How dare you?!'])
 console.log(' ', String(isSingleQuestion(q)).padEnd(6), JSON.stringify(q))
console.log('  -- controls that MUST stay rejected --')
for (const q of ['Did you ask her? Or did she?','Look at this. What do you mean?'])
 console.log(' ', String(isSingleQuestion(q)).padEnd(6), JSON.stringify(q))

console.log('\n=== H2-2: non-ASCII tokenization ===')
console.log(' echoesText cafe/café :', echoesText('The cafe is loud?', 'The café is loud.'))
console.log(' copiesSeed cafe/café :', copiesSeed('cafe in the plaza', 'café in the plaza'))
console.log(' isGrounded café      :', isGrounded('What about the café?', 'The café was loud.'))
console.log(' isGrounded déjà      :', isGrounded('Why déjà vu?', 'She felt déjà vu.'))
