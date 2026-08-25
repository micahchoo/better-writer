import { splitBlocks, partitionSections } from '../../web/text-window.js'

console.log('--- CRLF offsets ---')
const crlf = 'Alpha line one\r\nAlpha line two\r\n\r\nBeta block\r\n'
for (const blk of splitBlocks(crlf)) {
  console.log(JSON.stringify({ text: blk.text, start: blk.start, end: blk.end, slice: crlf.slice(blk.start, blk.end) }))
}

console.log('--- setext heading ---')
const setext = 'Chapter One\n===========\n\nBody paragraph here.\n\nAnother\n-------\n\nMore body.'
console.log(JSON.stringify(splitBlocks(setext).map(x => [x.kind, x.text])))
console.log('sections:', partitionSections(splitBlocks(setext)).length)

console.log('--- thematic break glued to paragraph ---')
const glued = 'Some text\n---\nMore text'
console.log(JSON.stringify(splitBlocks(glued).map(x => [x.kind, x.text])))
console.log('sections:', partitionSections(splitBlocks(glued)).length)
