import { staleAnnotations } from '../../web/coach-sweep.js'
const draft = 'aaa echo bbb ccc ddd echo eee'
const second = draft.indexOf('echo', 5)
const note = { start: second, end: second + 4, fragment: 'echo',
  context: { before: draft.slice(Math.max(0, second - 32), second), after: draft.slice(second + 4, second + 36) } }
const noCtx = { start: second, end: second + 4, fragment: 'echo' }
for (const [label, edited] of [
  ['insert 40 chars BETWEEN the two', draft.slice(0, 12) + 'x'.repeat(40) + draft.slice(12)],
  ['insert 40 chars BEFORE both',     'y'.repeat(40) + draft],
] as [string,string][]) {
  const withCtx = staleAnnotations([note], edited)[0]
  const without = staleAnnotations([noCtx], edited)[0]
  const want = edited.indexOf('echo', edited.indexOf('echo') + 1)
  console.log(label.padEnd(34), 'with context ->', withCtx ? withCtx.start : null, withCtx && withCtx.start === want ? '(correct)' : '(WRONG)',
              '| without ->', without ? without.start : null, without && without.start === want ? '(correct)' : '(WRONG)')
}
