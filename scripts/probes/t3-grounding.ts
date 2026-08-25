/**
 * R4 acceptance measurement: grounding rate of real seed-bank questions
 * against real draft windows, old prefix rule vs new stem rule. The R4 entry
 * demanded this number — the prefix fix tightened isGrounded with no measure
 * of how many good questions it started failing.
 */
import { readFileSync } from 'node:fs'
import { isGrounded } from '../../src/gate.js'
import { SAMPLE_DRAFT } from '../../web/sample-draft.js'
import { planSweep } from '../../web/coach-sweep.js'

const STOP = new Set('the a an and or but of in on at to for with from by as is are was were be been being this that these those it its your you my i me we our they their he she him her his them if so such not no yes do does did have has had will would can could should may might must about into over under again then once here there when where why how what who which while after before until because than too very just also only own same other said say says out up down off through all any each more most some few both between among without within across behind beyond above below near far long short much many'.split(' '))
const content = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t)))

// The rule f37a156 shipped, reproduced here to compare against.
function groundedPrefix(q: string, w: string): boolean {
  for (const a of content(q)) for (const b of content(w)) {
    if (Math.min(a.length, b.length) < 4) continue
    const [s, l] = a.length <= b.length ? [a, b] : [b, a]
    if (l.startsWith(s)) return true
  }
  return false
}

const questions = readFileSync(new URL('../../seeds/bank.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l).question as string).filter(Boolean)
const windows = planSweep(SAMPLE_DRAFT).map((p) => p.markedText)
  .filter((w) => typeof w === 'string' && w.length > 0)

let prefix = 0, stemHit = 0, total = 0, prefixOnly = 0, stemOnly = 0
for (const q of questions) for (const w of windows) {
  total++
  const p = groundedPrefix(q, w), s = isGrounded(q, w)
  if (p) prefix++
  if (s) stemHit++
  if (p && !s) prefixOnly++
  if (s && !p) stemOnly++
}
const pct = (n: number) => ((n / total) * 100).toFixed(1) + '%'
console.log(`pairs: ${total} (${questions.length} seed questions x ${windows.length} windows of SAMPLE_DRAFT)`)
console.log(`grounded, prefix rule (f37a156): ${prefix} = ${pct(prefix)}`)
console.log(`grounded, stem rule    (R4 fix): ${stemHit} = ${pct(stemHit)}`)
console.log(`  lost by the stem rule (prefix-only): ${prefixOnly} = ${pct(prefixOnly)}`)
console.log(`  won by the stem rule (stem-only):    ${stemOnly} = ${pct(stemOnly)}`)
