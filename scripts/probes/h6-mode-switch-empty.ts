/**
 * H6-3 probe — mode-switch load leaves STALE annotations when the new store
 * has zero annotations.
 *
 * EditorApp.tsx:254-279 loadDraftAndNotes() restores annotations only when the
 * loaded list is non-empty:
 *
 *     .then((annotations) => {
 *       if (seq !== loadSeqRef.current || annotations.length === 0) return
 *       const valid = staleAnnotations(annotations, draftRef.current)
 *       if (valid.length === 0) return
 *       annotationsRef.current = valid
 *       setSweepNotes(valid)
 *     })
 *
 * When the DESTINATION store has no annotations (annotations.length === 0),
 * the early return leaves annotationsRef/sweepNotes holding whatever the
 * PREVIOUS store had. On a mode switch between stores with different
 * persistence (local ServerDraftStore <-> static/byok LocalStorageDraftStore),
 * the old store's notes survive onto the new draft, and the next save persists
 * them into the new store. Even static<->byok, if the destination's draft is
 * fresh while the source held notes, stale notes pin to wrong offsets.
 *
 * This probe replicates the exact guard and the annotation mutators that
 * follow (handleContentChange persists annotationsRef on the next edit).
 */
import { staleAnnotations } from '../../web/coach-sweep'

// ---- EditorApp replication of loadDraftAndNotes ----
let annotationsRef: { start: number; end: number; fragment: string }[] = []
let sweepNotes: { start: number; end: number; fragment: string }[] = []
let persistedToNewStore: { draft: string; notes: unknown[] }[] = []

const SOURCE_NOTES = [
  { start: 0, end: 5, fragment: 'alpha beta gamma delta' },
  { start: 40, end: 46, fragment: 'epsilon zeta eta theta' },
]

// A store whose load() returns a draft but an EMPTY annotation list.
const emptyNoteStore = {
  // New draft in the destination store; it happens to contain one surviving
  // fragment ('alpha beta gamma delta'), so a stale note re-anchors and sticks.
  load: async () => 'alpha beta gamma delta and then a brand new draft continues',
  loadAnnotations: async () => [] as { start: number; end: number; fragment: string }[],
  save: async (draft: string, notes: unknown[]) => {
    persistedToNewStore.push({ draft, notes })
  },
}

// Replicate the exact loadDraftAndNotes body.
function loadDraftAndNotes(store: { load(): Promise<string>; loadAnnotations(): Promise<unknown[]> }) {
  return store
    .load()
    .then((text) => {
      // (draftRef.current = text; setDraft(text); editorAccess.replaceDocument)
      return store.loadAnnotations()
    })
    .then((annotations) => {
      if (annotations.length === 0) return // <-- THE GUARD UNDER TEST
      const valid = staleAnnotations(annotations, 'draft') as { start: number; end: number; fragment: string }[]
      if (valid.length === 0) return
      annotationsRef = valid
      sweepNotes = valid
    })
}

console.log('=== H6-3 mode-switch: empty destination annotations ===')
// Pre-state: user is in the SOURCE store with two notes on screen.
annotationsRef = [...SOURCE_NOTES]
sweepNotes = [...SOURCE_NOTES]

// Switch modes -> the load effect runs against the destination store, which
// has a draft but zero annotations.
await loadDraftAndNotes(emptyNoteStore)

console.log(`after load, sweepNotes (on screen) = ${sweepNotes.length} notes`)
console.log(`after load, annotationsRef        = ${annotationsRef.length} notes`)
console.log(`EXPECTED (fresh store, no notes): sweepNotes=0, annotationsRef=0`)
console.log(`OBSERVED: sweepNotes=${sweepNotes.length}, annotationsRef=${annotationsRef.length}`)

// The stale notes are now overlaid on the NEW draft, and the next edit saves
// them into the new store:
const NEW_DRAFT = 'alpha beta gamma delta and then a brand new draft continues'
const stale = staleAnnotations(annotationsRef, NEW_DRAFT)
await emptyNoteStore.save(NEW_DRAFT, stale)
console.log(`next save persisted ${persistedToNewStore[0].notes.length} notes into the NEW store (the surviving stale fragment re-anchored and stuck)`)

const leaked =
  sweepNotes.length === SOURCE_NOTES.length &&
  persistedToNewStore[0].notes.length > 0 &&
  stale.length > 0
console.log(
  leaked
    ? 'RESULT: STALE-NOTE LEAK CONFIRMED — empty destination annotations are not cleared; old-store notes stay on screen and are persisted into the new store.'
    : 'RESULT: no leak',
)
