/**
 * H6-2 probe — Sweep button double-invocation (re-entry guard is React state).
 *
 * EditorApp.tsx:545-597 sweepDraft() guards with:
 *     if (!coach || sweeping) return
 * where `sweeping` is React STATE (the render's snapshot), while it sets the
 * durable latch via `sweepingRef.current = true`. Two synchronous click
 * handlers (a double-click) run back-to-back BEFORE React re-renders and
 * commits setSweeping(true), so both see `sweeping === false` and both enter.
 * Each then calls runSweep concurrently over the SAME windows -> every window
 * is asked twice -> duplicate notes/questions.
 *
 * This probe replicates the guard ordering: a `sweeping` snapshot that only
 * advances on a fake "re-render", and two back-to-back sweepDraft() calls.
 */
import { planSweep } from '../../web/coach-sweep'

// ---- EditorApp replication of the sweep guard + run ----
let sweeping = false // React state snapshot (commits only on re-render)
let sweepingRef = false // the ref latch
let askCount = 0
const DRAFT = Array.from({ length: 9 }, (_, p) =>
  Array.from({ length: 40 }, (_, i) => `p${p}w${i}`).join(' '),
).join('\n\n')

const coach = {
  lastSource: () => null,
  async ask() {
    askCount += 1
    await new Promise((r) => setTimeout(r, 1))
    return 'Question'
  },
}

function runSweepStub(plan: { texts: string[] }[], onNote: (n: { start: number; end: number; fragment: string; question: string; ts: number }) => void) {
  let i = 0
  const next = (): Promise<void> =>
    plan.length === 0
      ? Promise.resolve()
      : coach.ask().then((question) => {
          onNote({ start: i, end: i + 1, fragment: 'w', question, ts: Date.now() + i })
          i += 1
          return i < plan.length ? next() : undefined
        })
  return next()
}

function sweepDraft() {
  if (!coach || sweeping) return
  const fullText = DRAFT
  if (!fullText.trim()) return
  sweepingRef = true
  // (setSweeping(true) is async; the render snapshot `sweeping` is still false here)
  const plan = planSweep(fullText)
  const notes: number[] = []
  return runSweepStub(plan, () => {
    notes.push(notes.length)
  }).then(() => {
    sweepingRef = false
  })
}

// ---- double-click: two synchronous calls before any re-render ----
const plan = planSweep(DRAFT)
console.log(`=== H6-2 sweep re-entry via double-click ===`)
console.log(`planSweep(window-count) = ${plan.length}`)

const a = sweepDraft()
const b = sweepDraft() // same stale `sweeping === false` snapshot

await Promise.all([a, b])
console.log(`sweepingRef after both = ${sweepingRef}`)
console.log(`coach.ask invocations = ${askCount}`)
console.log(`window count = ${plan.length}`)
console.log(`---`)
console.log(`EXPECTED (one sweep): coach.ask invoked ${plan.length} times`)
console.log(`OBSERVED: coach.ask invoked ${askCount} times`)
console.log(
  askCount === plan.length
    ? 'RESULT: no re-entry — guard held'
    : `RESULT: RE-ENTRY CONFIRMED — double-click started ${askCount / plan.length} concurrent sweeps; every window asked ${askCount / plan.length}x`,
)
