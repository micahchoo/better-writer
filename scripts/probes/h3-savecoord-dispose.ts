/**
 * H3 — SaveCoordinator dispose() vs in-flight save.
 * If dispose() runs while a save is in flight and a newer pending payload
 * exists, does the finally-block re-arm a timer that saves AFTER unmount?
 */
import { SaveCoordinator, type SaveCoordinatorOptions } from '../../web/save-coordinator'
import type { DraftStore, Note } from '../../web/draft-store'

let now = 0
let seq = 0
type Timer = { cb: () => void; at: number }
const timers = new Map<number, Timer>()
const fakeWindow = {
  setTimeout: (cb: () => void, ms: number): number => {
    const id = ++seq
    timers.set(id, { cb, at: now + ms })
    return id
  },
  clearTimeout: (id: number): void => {
    void timers.delete(id)
  },
}
;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
const advance = (ms: number): void => {
  const target = now + ms
  const due = [...timers.values()].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)
  timers.clear()
  now = target
  for (const t of due) t.cb()
}

async function main(): Promise<void> {
  let onSettle: ((k: 'ok' | 'err') => void) | null = null
  const saves: string[] = []
  const store: DraftStore = {
    save: async (draft: string): Promise<void> => {
      saves.push(draft)
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      onSettle = (k) => (k === 'ok' ? resolve() : reject(new Error('x')))
      return promise
    },
    load: async () => '',
    loadAnnotations: async (): Promise<Note[]> => [],
  }
  const opts: SaveCoordinatorOptions = { getStore: () => store, onError: () => undefined, onSaveState: () => undefined }
  const c = new SaveCoordinator(opts)

  c.edit('A', [])
  advance(1000) // debounce fires -> save("A") in flight
  c.edit('B', []) // newer pending, debounce armed
  const beforeDispose = timers.size
  c.dispose() // component unmount: clears timers
  const afterDispose = timers.size
  onSettle?.('ok') // in-flight save("A") completes
  await new Promise((r) => setTimeout(r, 0)) // finally runs
  const afterFinally = timers.size
  advance(1000) // fire any re-armed timer
  await new Promise((r) => setTimeout(r, 0))

  console.log('timers before dispose        :', beforeDispose)
  console.log('timers after dispose         :', afterDispose)
  console.log('timers after in-flight done  :', afterFinally, '(finally re-armed a timer?)')
  console.log('saves received               :', JSON.stringify(saves))
  if (afterFinally > 0) {
    console.log('BUG H3: dispose() cannot prevent the finally-block re-arm; a save fires after unmount.')
  } else {
    console.log('no post-dispose timer armed.')
  }
}

void main()
