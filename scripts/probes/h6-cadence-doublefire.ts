/**
 * H6-1 probe — auto-ask double-fire while a previous ask is in flight.
 *
 * Replicates EditorApp.tsx exactly:
 *   - cadence machine (web/cadence.ts, imported real)
 *   - the 5 s auto-ask poll (EditorApp.tsx:319-324) calling maybeFireCadence
 *   - maybeFireCadence (EditorApp.tsx:367-377): fires askCursorWindow when
 *     observe() returns 'ready' — NO in-flight guard
 *   - askCursorWindow (EditorApp.tsx:385-439): cadence.reset(base) ONLY in the
 *     finally AFTER `await coach.ask(...)` resolves, and in the early-return
 *     branches (no coach / empty / no window)
 *
 * The defect: cadence.observe() is pure and does NOT self-reset after
 * returning 'ready'. While the first ask is in flight (not yet reset), every
 * 5 s poll re-observes the SAME quiet draft and returns 'ready' again -> a
 * second, third... concurrent ask. Double question on screen.
 *
 * The scheduler drains microtasks after each timer so promise continuations
 * (the ask's finally -> cadence.reset) land before the next poll, matching a
 * browser's timer/microtask interleaving.
 */
import { createCadence } from '../../web/cadence'

// ---- fake clock / scheduler (drains microtasks between timers) ----
let now = 0
let pending: Array<{ at: number; fn: () => void }> = []
function setTimer(delay: number, fn: () => void) {
  pending.push({ at: now + delay, fn })
}
async function advance(ms: number) {
  const end = now + ms
  for (;;) {
    const next = pending.filter((p) => p.at <= end).sort((a, b) => a.at - b.at)[0]
    if (!next) break
    pending = pending.filter((p) => p !== next)
    now = next.at
    next.fn()
    await new Promise((r) => setImmediate(r)) // drain microtasks (finally -> reset)
  }
  now = end
}

// ---- EditorApp replication (only the cadence/ask path) ----
const cadence = createCadence()
let draftRef = ''
let inFlight = 0
let maxConcurrent = 0
const firedAt: number[] = []
const resolvedAt: number[] = []

// Slow coach: a real LLM ask takes >5 s, so the poll runs again mid-flight.
const ASK_LATENCY = 8000
const coach = {
  lastSource: () => null,
  async ask(_marked: string, _genre: unknown, _offset: number) {
    await new Promise<void>((res) => setTimer(ASK_LATENCY, res))
    return 'A question'
  },
}

function askCursorWindow(text: string) {
  const base = text
  // (splitBlocks/window checks omitted: window always exists here)
  inFlight += 1
  maxConcurrent = Math.max(maxConcurrent, inFlight)
  firedAt.push(now)
  void (async () => {
    try {
      const question = await coach.ask('', null, 0)
      resolvedAt.push(now)
      void question
    } catch {
      /* silent */
    } finally {
      cadence.reset(base, now)
      inFlight -= 1
    }
  })()
}

function maybeFireCadence(text: string) {
  const phase = cadence.observe(text, now)
  // mayAutoAsk(modeRef) true (local), !sweepingRef, !cadencePausedRef
  if (phase === 'ready') askCursorWindow(text)
}

// ---- drive: poll every 5 s (EditorApp.tsx:319-324) ----
const POLL = 5000
function startPoll() {
  setTimer(POLL, function tick() {
    maybeFireCadence(draftRef)
    setTimer(POLL, tick)
  })
}

const SMALL = 'one two three four five'
const BIG = Array.from({ length: 45 }, (_, i) => 'w' + i).join(' ')

draftRef = SMALL
maybeFireCadence(draftRef) // t=0 -> 'idle', baseline=5
startPoll()

await advance(1000)
draftRef = BIG
maybeFireCadence(draftRef) // t=1000 -> 'armed' (netNew=40, lastEditAt=1000)

// First 'ready' fires at the t=25s poll (lastEditAt=1000, quiet >= 20s). Ask
// #1 in flight (resolves at 33s). Advance to t=40000 so we see whether the
// poll re-fires while ask #1 is unresolved.
await advance(39000)
const afterBoth = firedAt.length
// Post-reset check: once the in-flight asks resolve (reset cadence), the poll
// must stop re-firing.
const beforeFinal = firedAt.length
await advance(10000)
const afterFinal = firedAt.length - beforeFinal

console.log('=== H6-1 auto-ask double-fire during in-flight ask ===')
console.log(`asks fired (by t=40s)     = ${afterBoth} at t = ${firedAt.slice(0, afterBoth).map((t) => `${(t / 1000).toFixed(0)}s`).join(', ')}`)
console.log(`asks resolved (by t=40s)  = ${resolvedAt.map((t) => `${(t / 1000).toFixed(0)}s`).join(', ')}`)
console.log(`max concurrent asks in flight = ${maxConcurrent}`)
console.log(`asks fired after first resets land (next 10s) = ${afterFinal} (expected 0)`)
console.log(`---`)
console.log(`EXPECTED: 1 ask fired, max concurrent 1`)
console.log(`OBSERVED: ${afterBoth} asks fired, max concurrent ${maxConcurrent}`)
console.log(
  afterBoth > 1 && maxConcurrent > 1
    ? 'RESULT: DOUBLE-FIRE CONFIRMED — cadence.reset() is deferred to ask completion, so the 5s poll re-fires while the first ask is in flight.'
    : 'RESULT: no double-fire',
)
