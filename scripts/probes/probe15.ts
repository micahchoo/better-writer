import { planSweep } from '../../web/coach-sweep.js'
import { splitBlocks, partitionSections, CURSOR_START, CURSOR_END } from '../../web/text-window.js'
import { SAMPLE_DRAFT } from '../../web/sample-draft.js'

function audit(name: string, md: string) {
  const plan = planSweep(md)
  const blocks = splitBlocks(md)
  const sections = partitionSections(blocks)
  const problems: string[] = []

  // 1. do window bounds cover every block exactly once, in order?
  let covered = 0
  for (const w of plan) {
    if (w.bounds.end < w.bounds.start) problems.push('inverted bounds')
    if (w.bounds.start < covered) problems.push(`overlapping window at ${w.bounds.start} (prev ended ${covered})`)
    covered = w.bounds.end
  }
  // 2. is the marked text actually a slice of the draft?
  for (const [i, w] of plan.entries()) {
    const stripped = w.markedText.split(CURSOR_START).join('').split(CURSOR_END).join('').trim()
    const first = stripped.split('\n')[0]
    if (first && !md.includes(first)) problems.push(`window ${i} text not found in draft: ${JSON.stringify(first.slice(0,40))}`)
  }
  // 3. cursorHint inside its own bounds?
  for (const [i, w] of plan.entries()) {
    if (w.cursorHint < w.bounds.start || w.cursorHint > w.bounds.end) problems.push(`window ${i} cursorHint outside bounds`)
  }
  // 4. does any window span a section boundary?
  const sectionOf = new Map<number, number>()
  sections.forEach((sec, si) => sec.forEach((b) => sectionOf.set(b.start, si)))
  for (const [i, w] of plan.entries()) {
    const inWin = blocks.filter((b) => b.start >= w.bounds.start && b.end <= w.bounds.end)
    const ss = new Set(inWin.map((b) => sectionOf.get(b.start)))
    if (ss.size > 1) problems.push(`window ${i} spans ${ss.size} sections`)
  }
  // 5. budget
  const over = plan.filter((w) => w.markedText.length > 1200)
  console.log(`${name}: ${blocks.length} blocks, ${sections.length} sections, ${plan.length} windows, ${over.length} over budget`)
  problems.length ? problems.forEach((p) => console.log('   !! ' + p)) : console.log('   ok')
}

audit('sample draft', SAMPLE_DRAFT)
audit('CRLF doc', 'Alpha one\r\nAlpha two\r\n\r\n# Head\r\n\r\nBeta one\r\nBeta two\r\n\r\nGamma here.\r\n')
audit('setext doc', 'Chapter One\n===========\n\nBody a.\n\nBody b.\n\nChapter Two\n-----------\n\nBody c.')
audit('one huge block', 'x '.repeat(2000))
audit('all headings', ['# a','# b','# c','# d'].join('\n\n'))
audit('empty', '')
audit('two blocks', 'One paragraph.\n\nTwo paragraph.')
audit('trailing stub across sections', '# A\n\np1.\n\np2.\n\n# B\n\np3.')
