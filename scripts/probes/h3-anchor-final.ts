/**
 * H3-1 — consolidated repro: anchor offset math vs Unicode case-folding that
 * changes code-unit length. The contract (anchor.test.ts) is that
 * draft.slice(match.start, match.end) is the exact matched word. For any
 * token containing U+0130 (İ -> "i\u0307" on toLowerCase, 1->2 code units)
 * that contract breaks: match.end (and match.start) are computed from the
 * lowercased word's length/indexOf, which no longer equals the raw offsets.
 */
import { extractAnchor } from '../../web/anchor'

function check(label: string, q: string, d: string, cursor: number): void {
  const a = extractAnchor(q, d, cursor)
  if (!a) {
    console.log(`  ${label}: (no anchor)`)
    return
  }
  const slice = d.slice(a.match.start, a.match.end)
  const inBounds = a.match.start >= 0 && a.match.end <= d.length
  const anchorInBounds = a.start >= 0 && a.end <= d.length
  const flags: string[] = []
  if (/\s/.test(slice)) flags.push('match leaks whitespace')
  if (!inBounds) flags.push('match OUT OF DOC')
  if (!anchorInBounds) flags.push('ANCHOR OUT OF DOC')
  if (flags.length) console.log(`  BUG  ${label}: match=[${a.match.start},${a.match.end}) slice=${JSON.stringify(slice)} ${flags.join('; ')}`)
  else console.log(`  ok   ${label}: match=${JSON.stringify(slice)}`)
}

// 1. initial İ, word followed by space  -> match includes trailing space
check('initial-İ', 'What did they see in \u0130stanbul?', 'A road through \u0130stanbul at dawn.', 20)
// 2. İ as last token of doc             -> match.end exceeds draft length
check('İ-at-doc-end', 'What about \u0130stanbul?', 'Go to \u0130stanbul', 8)
// 3. İ as token prefix                  -> both start and end shift ("typed" -> "yped ")
check('İ-prefix-in-token', 'What about typed?', 'the \u0130typed ocean', 6)
// 4. verbatim-quote path                -> needle lowered grows, match leaks
check('İ-quote-path', 'Why call it "\u0130stanbul is the bridge" city?', 'He said "\u0130stanbul is the bridge city." today.', 10)
