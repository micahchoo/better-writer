import { isSingleQuestion, isGrounded, echoesText, copiesSeed, stripCursorMarkers } from '../../src/core/gate.js'
import { CURSOR_START, CURSOR_END } from '../../src/core/text-window.js'

const t = (label: string, v: unknown) => console.log(`${String(v).padEnd(5)} ${label}`)

console.log('=== isSingleQuestion: things that SHOULD be rejected ===')
t('multi-sentence, one ?: "Look at this. What do you mean?"', isSingleQuestion('Look at this. What do you mean?'))
t('a command with a ? tacked on', isSingleQuestion('Rewrite the whole paragraph in second person?'))
t('prose + question, 300 chars', isSingleQuestion('Here is my reasoning: the passage is weak because the verbs are flat and the nouns abstract, and the narrator hedges. ' + 'Given all that, what would you cut?'))
t('markdown bold list-ish "**- item?**"', isSingleQuestion('**- Which detail carries the weight?**'))
t('leading quote then list', isSingleQuestion('"1. What is at stake?'))
t('em-dash bullet', isSingleQuestion('— Which verb is doing the work?'))
t('tab-indented bullet', isSingleQuestion('\t- What is at stake?'))
t('unicode fullwidth question mark', isSingleQuestion('What is at stake？'))

console.log('\n=== isSingleQuestion: things that SHOULD be accepted ===')
t('normal', isSingleQuestion('What does the skillet weigh in her hands?'))
t('question containing "?" in a quote', isSingleQuestion('You wrote "why?" — what does she mean?'))

console.log('\n=== isGrounded: 4-char substring rule ===')
t('"walked" vs "walk"', isGrounded('Why walk here?', 'She walked home.'))
t('"other" matches inside "brother" (unrelated)', isGrounded('What other thing?', 'My brother left.'))
t('"time" matches inside "sometimes"', isGrounded('What time is it?', 'He sometimes hesitates.'))
t('"read" matches inside "already"', isGrounded('Does the reader know?', 'She had already gone.'))
t('"ring" inside "bring"/"during"', isGrounded('Which ring matters?', 'During the walk he did bring it.'))

console.log('\n=== echoesText: cursor envelope ===')
const win = `Block before the cursor sits here.\n\n${CURSOR_START}\nThe cat sat on the mat.\n${CURSOR_END}\n\nBlock after the cursor sits here.`
t('verbatim restatement of the marked block', echoesText('The cat sat on the mat?', win))
t('restatement with one word changed', echoesText('The cat sat on the rug?', win))

console.log('\n=== stripCursorMarkers ===')
t('markers removed', stripCursorMarkers(`a ${CURSOR_START} b ${CURSOR_END} c`) === 'a  b  c')
console.log('   result:', JSON.stringify(stripCursorMarkers(`a ${CURSOR_START} b ${CURSOR_END} c`)))
