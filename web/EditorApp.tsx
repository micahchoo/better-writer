import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Expand, Eye, EyeOff, Mic, MicOff, Moon, Sun, X } from 'lucide-react'
import { GENRES, type Genre } from '../src/types'
import { extractAnchor } from './anchor'
import { createCadence, type Cadence } from './cadence'
import { planSweep, reconcileAnnotations, runSweep, staleAnnotations } from './coach-sweep'
import {
  ByokCoach,
  loadByokConfig,
  isValidBaseUrl,
  saveByokConfig,
  PRESETS,
  TRANSCRIBES_AUDIO,
  sttModelFor,
  transcribeWavByok,
  type Provider,
} from './byok'
import { detectServerMode, isModelBacked, makeCoach, mayAutoAsk, type Coach, type CoachMode } from './coach'
import { createEditorAccess } from './editor-access'
import CodeMirrorHost, { editorTheme } from './codemirror-host'
import { highlightExtension } from './decorations'
import { makeDraftStore, type AnchorRecord, type DraftStore } from './draft-store'
import { makeNote, noteId, sameNote } from './notes'
import { pickRecordingMimeType, transcribeAudio } from './dictation'
import { HighlightOverlay, noteFromMark } from './highlight'
import { InboxPanel } from './inbox-panel'
import { MarkdownPreview } from './markdown-preview'
import { SAMPLE_DRAFT } from './sample-draft'
import { SaveCoordinator } from './save-coordinator'
import { SaveIndicator, type SaveIndicatorDisplay } from './save-indicator'
import { buildAskWindow, cursorWindow, splitBlocks } from './text-window'
import { useTheme } from './theme'

// Model-field hints per provider — placeholders only, never written to the
// saved config. The writer supplies the real model at save time.
const MODEL_PLACEHOLDERS: Record<Provider, string> = {
 openrouter: 'openai/gpt-4o-mini',
 openai: 'gpt-4o-mini',
 groq: 'meta-llama/llama-3.3-70b-instruct',
 custom: 'e.g. your-model-id',
}
// Preview toggle cycles the rendered pane off → split → full → off.
const PREVIEW_CYCLE: Array<'off' | 'split' | 'full'> = ['off', 'split', 'full']

export default function EditorApp() {
 const [mode, setMode] = useState<CoachMode | 'detecting'>('detecting')
 // App theme owned by <html data-theme> (see theme.ts): useTheme applies the
 // theme to the root element and persists the toggle; CSS and the CM editor
 // read the same var(--token) values, so a swap restyles instantly.
 const [theme, setTheme] = useTheme()
 const [draft, setDraft] = useState('')
 // Genre is remembered across reloads; anything not in GENRES (stale value,
 // storage disabled) falls back to the agnostic default.
 const [genre, setGenre] = useState<Genre>(() => {
  try {
   const saved = window.localStorage.getItem('better-writer:genre')
   return saved !== null && GENRES.includes(saved as Genre) ? (saved as Genre) : 'genre-agnostic'
  } catch {
   return 'genre-agnostic' // storage disabled (private mode): start agnostic
  }
 })
 const [error, setError] = useState<string | null>(null)
 const [dictationState, setDictationState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
 const [sweeping, setSweeping] = useState(false)
 // Sweep progress: completed window count over the plan length, null when idle.
 const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
 // Sweep notes on screen: one highlight per note across the whole draft.
 const [sweepNotes, setSweepNotes] = useState<AnchorRecord[]>([])
 // SINGLE-OPEN contract: at most one note popover is open at a time, keyed
 // by the note's identity string. Two popovers can never overlap because a
 // new open supersedes the previous one.
 const [openNoteId, setOpenNoteId] = useState<string | null>(null)
 // Monotonic viewport tick, bumped by the seam's onViewportChange (host
 // wiring) on selection/doc updates, scroller scroll, and window resize.
 // Popovers re-run placement on it so they stay pinned to their anchors.
 const [viewportTick, setViewportTick] = useState(0)
  // Debounced save-status display (save-indicator.ts): 'Saving…' appears only
 // once a save lingers past its pending window; 'Saved' sticks for the sticky
 // window then reverts to idle. Rapid queued saves never flicker.
 const [saveDisplay, setSaveDisplay] = useState<SaveIndicatorDisplay>('idle')
 const [saveIndicator] = useState(() => new SaveIndicator(setSaveDisplay))
 // Wall-clock time of the last confirmed save, captured AT save-completion.
 const [saveTime, setSaveTime] = useState<Date | null>(null)
 // Coach panel collapse: minimized shows only the slim header bar (chevron),
 // expanded shows the body. Persisted so a reload keeps the panel collapsed.
 const [coachCollapsed, setCoachCollapsed] = useState<boolean>(() => {
  try {
   return window.localStorage.getItem('better-writer:coach-collapsed') === '1'
  } catch {
   return false // storage disabled: default expanded
  }
 })
 // Outcome of the last sweep (see SweepResult): pinned = anchored notes,
 // skipped = windows that produced none. Shown above the coach actions and
 // STAYS visible after the sweep completes — not a toast.
 const [sweepSummary, setSweepSummary] = useState<{
   asked: number
   skipped: number
   pinned: number
 } | null>(null)
 // Auto-ask cadence pause: when paused the cadence driver still observes
 // (cheap) but never fires a question.
 const [cadencePaused, setCadencePaused] = useState(false)
 // Sample-draft loader is one-shot and persisted nowhere: a reload returns to
 // the real (still-empty) page, so the button offers the sample again.
 const [sampleLoaded, setSampleLoaded] = useState(false)
 // BYOK settings panel: open flag plus the controlled form. The form is
 // re-seeded from the saved config on every open (see openByokPanel), so these
 // initial values are placeholders until the first open.
 const [byokOpen, setByokOpen] = useState(false)
 const [byokForm, setByokForm] = useState<{
  provider: Provider
  baseUrl: string
  model: string
  apiKey: string
 }>({ provider: 'openrouter', baseUrl: PRESETS.openrouter, model: '', apiKey: '' })
 // Tri-mode rendered preview. Split is the DEFAULT (side-by-side on load; no
// persistence — every fresh load starts split, the user cycles from there).
// 'off' edits full-width; 'split' shows the rendered pane LIVE beside the
// editor (the renderer debounces ~250ms inside markdown-preview.tsx so
// keystrokes never pay an O(doc) pass); 'full' hides the cm host VISUALLY
// (className swap to display:none — never unmounts it) so the undo stack,
// caret, and history survive the round-trip; the editor stays live and keeps
// dispatching even while hidden. `draft` is the source of truth for the pane.
const [previewMode, setPreviewMode] = useState<'off' | 'split' | 'full'>('split')
const cyclePreview = () =>
 setPreviewMode((m) => PREVIEW_CYCLE[(PREVIEW_CYCLE.indexOf(m) + 1) % PREVIEW_CYCLE.length])
// The toggle's label names the NEXT action: off→split, split→full, full→off.
const nextPreviewLabel =
 previewMode === 'off' ? 'Show split preview' : previewMode === 'split' ? 'Expand preview' : 'Back to editing'

 const draftRef = useRef('')
 // Start from the restored genre so a sweep right after reload (which reads
 // genreRef.current) uses the persisted choice, not the agnostic default.
 const genreRef = useRef<Genre>(genre)
 const coachRef = useRef<Coach | null>(null)
 const draftStoreRef = useRef<DraftStore | null>(null)
 // Built via useState's one-time initializer (not on first edit) so note
 // ops — resolve, clear, sweep appends — can persist through it before any
 // keystroke exists. useState (not useRef) because the value is never
 // reassigned and must be non-null at every callsite.
 const [coordinator] = useState(new SaveCoordinator({
  getStore: () => draftStoreRef.current,
  onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  // Save-lifecycle pulse for the topbar indicator: 'saving' on send, and on
  // 'saved' stamp the completion time (the HH:MM shown next to the badge).
   onSaveState: (phase) => {
  // Feed raw pulses into the debounced indicator; stamp the completion time
  // on confirm (the HH:MM shown next to the badge).
  if (phase === 'saving') saveIndicator.saveStarted()
  else {
   saveIndicator.saveSucceeded()
   setSaveTime(new Date())
  }
 },
 }))
 const recorderRef = useRef<MediaRecorder | null>(null)
 const chunksRef = useRef<Blob[]>([])
 const annotationsRef = useRef<AnchorRecord[]>([])
 // Sweep cancel latch: set by the Stop button, read by runSweep's
 // shouldAbort before each window so the in-flight ask finishes cleanly.
 const abortSweepRef = useRef(false)
 // Cadence state machine (cadence.ts). Lazy-initialized through useRef so
 // re-renders never rebuild the machine; the 5s poll closure reads this ref.
 const cadenceRef = useRef<Cadence | null>(null)
 if (cadenceRef.current === null) cadenceRef.current = createCadence()
 const cadence = cadenceRef.current
 // Mirrors of `sweeping` / `cadencePaused` for the interval closure: a 5s
 // tick must not fire an auto-ask mid-sweep or while paused, but a closure
 // captured at mount can't see React state — these refs always can.
 const sweepingRef = useRef(false)
 const cadencePausedRef = useRef(false)
 // Mirror of `mode` so the recorder's onstop closure can read the mode at
 // STOP time (not the mode captured when recording began). A closure captured
 // at mount can't see React state — this ref always can.
 const modeRef = useRef(mode)
 modeRef.current = mode
 // The one editor adapter, wired to the CM6 seam and themed to match the old
 // textarea surface. Built once via useMemo (the host mounts it); the theme
 // (and, in Task 5, the highlight extension) ride in through the seam's
 // `extensions` passthrough so no caller ever touches the EditorView.
 const editorAccess = useMemo(
  () => createEditorAccess({ extensions: [editorTheme, highlightExtension()] }),
  [],
 )

  // Mode detection: a saved BYOK config wins — adopt byok synchronously (the
// whole pipeline is browser-resident, so no probe is needed). Otherwise probe
 // GET /health once: 200 JSON -> local mode (LocalCoach + ServerDraftStore);
 // anything else -> static demo (StaticCoach + LocalStorageDraftStore). GitHub
 // Pages is auto-static.
 useEffect(() => {
  let cancelled = false
  const stored = loadByokConfig()
  if (stored) {
   coachRef.current = new ByokCoach()
   draftStoreRef.current = makeDraftStore('byok')
   setMode('byok')
   return () => {
    cancelled = true
   }
  }
  void detectServerMode().then((detected) => {
   if (cancelled) return
   coachRef.current = makeCoach(detected)
   draftStoreRef.current = makeDraftStore(detected)
   setMode(detected)
  })
  return () => {
   cancelled = true
  }
 }, [])

 // Load the saved draft from a store, then restore every persisted annotation
 // whose fragment still sits at its offsets. Shared by the mode-load effect
 // AND the BYOK adopt/disconnect paths, which swap the store without a reload
 // — the writer's prose must come from whichever store the new mode reads.
 // Latest-load-wins token: an older async load (e.g. from a mode we have
 // already left) must not overwrite a newer one, so each call stamps a fresh
 // seq and only the most recent is allowed to apply its result.
 const loadSeqRef = useRef(0)
 const loadDraftAndNotes = (store: DraftStore) => {
  const seq = ++loadSeqRef.current
  void store
   .load()
   .then((text) => {
    if (seq !== loadSeqRef.current) return Promise.resolve([])
    draftRef.current = text
    setDraft(text)
    // Push the restored doc into the editor. The reset path does NOT fire
    // onDocChange, so the setDraft above stays the authoritative state sync
    // and no spurious save/reconcile runs. No-op if the host hasn't attached.
    editorAccess.replaceDocument(text, { history: 'reset' })
    return store.loadAnnotations()
   })
   .then((annotations) => {
    if (seq !== loadSeqRef.current || annotations.length === 0) return
    const valid = staleAnnotations(annotations, draftRef.current) as AnchorRecord[]
    if (valid.length === 0) return
    annotationsRef.current = valid
    setSweepNotes(valid)
   })
   .catch((err: unknown) => {
    if (seq === loadSeqRef.current) setError(err instanceof Error ? err.message : String(err))
   })
 }

 // Load once the mode (and store) is known.
 useEffect(() => {
  if (mode === 'detecting' || !draftStoreRef.current) return
  loadDraftAndNotes(draftStoreRef.current)
 }, [mode])

// Unmount cleanup: cancel the coordinator's pending timers, stop any recording.
 useEffect(() => {
 return () => {
  coordinator.dispose()
  saveIndicator.dispose()
  recorderRef.current?.stop()
 }
}, [])

// Flush-on-hide: persist any pending draft when the tab hides or the page
// unloads, so a closed tab doesn't drop the latest keystrokes. keepalive
// lets the browser finish the request even as the page is torn down; flush
// no-ops when nothing is pending and routes failures through onError.
useEffect(() => {
 const flushOnHide = () => {
  void coordinator.flush({ keepalive: true })
 }
document.addEventListener('visibilitychange', flushOnHide)
window.addEventListener('pagehide', flushOnHide)
return () => {
 document.removeEventListener('visibilitychange', flushOnHide)
 window.removeEventListener('pagehide', flushOnHide)
}
}, [])

// Auto-ask poll: cadence re-checks every 5 s even with no further typing, so
// a draft that grew past the threshold and then went quiet still fires while
// the writer reads. The closure only reads refs (cadence, draftRef, the
// suppression mirrors, the setters), so a mount-time capture never goes
// stale — an empty dep array is safe here.
useEffect(() => {
 const timer = window.setInterval(() => {
  maybeFireCadence(draftRef.current)
 }, 5000)
 return () => window.clearInterval(timer)
}, [])

// C2 — derived marks: highlights are REBUILT from reconciled React state on
// every draft/annotation change and pushed wholesale through the seam's
// showHighlights. Nothing in CM6 maps highlight positions across transactions
// independently; the StateField simply replaces the set each time. The tone is
// uniform (the marker style is shared); per-note offset data rides on the
// marks' data-start/data-end for click delegation.
useEffect(() => {
 const spans = sweepNotes.map((note) => ({ start: note.start, end: note.end, tone: 'note' }))
 editorAccess.showHighlights(spans)
}, [sweepNotes, draft, editorAccess])

const handleContentChange = (value?: string) => {
 const text = value ?? ''
 draftRef.current = text
 setDraft(text)

 // Cadence: feed every change through the machine; if the draft grew past
 // the threshold AND the writer paused long enough, fire one auto-ask.
 maybeFireCadence(text)

// Re-validate every annotation against the new text: drop notes whose
// fragment is gone, adopt remapped offsets for ones that moved intact.
// Branch on changed, not length — a pure remap keeps the count, and only
// adopting the list here keeps the highlight AND the next save correct.
const { valid, changed } = reconcileAnnotations(annotationsRef.current, text)
if (changed) {
 annotationsRef.current = valid
 setSweepNotes(valid)
 void coordinator.persistNow(text, valid)
}

 // Debounced draft save, serialized through the coordinator.
 coordinator.edit(text, annotationsRef.current)
}

// The shared cadence driver used by BOTH the content-change handler and the
// 5 s poll. observe() is cheap and side-effect-free; firing is suppressed
// while a sweep runs, when the writer paused the Auto-ask toggle, or when the
// mode bills the writer per ask (mayAutoAsk — the Auto-ask CHECKBOX is hidden
// outside 'local', but hiding a control is not a gate: without this the timer
// still fired in byok and spent the writer's tokens unprompted).
const maybeFireCadence = (text: string) => {
 const phase = cadence.observe(text)
 if (
  phase === 'ready' &&
  mayAutoAsk(modeRef.current) &&
  !sweepingRef.current &&
  !cadencePausedRef.current
 ) {
  void askCursorWindow(text)
 }
}

// Auto-ask: fire ONE coach question in a pause, without touching the editor
// canvas. A 3-block window is built around the cursor block (like runSweep's
// windows) so the ask grounds near where the writer is working; the resulting
// note joins the inbox and persists like any other. Failures are silent (this
// is background pestering, not a user-initiated flow) but cadence is always
// re-armed so a bad ask can't wedge the cycle.
const askCursorWindow = async (text: string) => {
 const coach = coachRef.current
 if (!coach) {
  cadence.reset(text)
  return
 }
 const blocks = splitBlocks(text)
 if (blocks.length === 0) {
  cadence.reset(text)
  return
 }
 const cursor = editorAccess.readCursor()
 const caretOffset = cursor?.offset ?? Math.floor(text.length / 2)

 // The shared cursor-window constructor: the block under the caret centered
 // ±1 neighbor (edge-clipped), marked around the cursor block, so an auto-ask
 // window matches a sweep window's shape by construction.
 const win = cursorWindow(blocks, caretOffset)
 if (!win) {
  cadence.reset(text)
  return
 }
 const markedText = buildAskWindow(win.texts, win.markIndex)

 try {
  const question = await coach.ask(markedText, genreRef.current, caretOffset)
  const anchor = extractAnchor(question, text, caretOffset)
  if (anchor) {
   const record = makeNote(anchor, question)
   // Provenance from the coach, attached only when reported (legacy/static
   // asks carry none).
   const source = coach.lastSource()
   if (source) record.source = source
   annotationsRef.current = [...annotationsRef.current, record]
   setSweepNotes((prev) => [...prev, record])
   void coordinator.persistNow(draftRef.current, annotationsRef.current)
  }
 } catch {
  // Silent: a background ask must never surface a toast. cadence resets below.
 } finally {
  cadence.reset(text)
 }
}

// Jump the editor to a note's span: open its popover and scroll the
// scrollport so the anchored line is roughly centered. The scroll target is
// the note's character offset, handed to the seam (CM6 handles line/scroll
// mapping internally — no line-height math here).
const handleFocusNote = (note: AnchorRecord) => {
 setOpenNoteId(noteId(note))
 editorAccess.scrollToOffset(note.start)
}

// Click-open parity: the host wrapper div delegates span clicks here. CM6
// paints the highlights as native mark decorations carrying data-start/
// data-end (see decorations.ts buildHighlightSet), so a click on a mark
// resolves back to its note and toggles the SINGLE-OPEN slot — clicking an
// open note closes it, clicking a closed one opens it (the mirror-era
// toggle behavior).
const handleHighlightClick = (event: React.MouseEvent<HTMLDivElement>) => {
 const mark = (event.target as HTMLElement).closest('.bw-hl')
 const note = noteFromMark(mark, sweepNotes)
 if (!note) return
 const id = noteId(note)
 setOpenNoteId((prev) => (prev === id ? null : id))
}

  // Genre is remembered across reloads; a handler shared by every genre select
// (there is now one place it lives: the coach-actions row).
const handleGenreChange = (next: Genre) => {
 genreRef.current = next
 setGenre(next)
 try {
  window.localStorage.setItem('better-writer:genre', next)
 } catch {
  // Quota exceeded or storage disabled: fail soft — the choice just
  // doesn't survive a reload.
 }
}

// Collapse/expand the coach panel, persisting the choice so a reload keeps
// the panel as the writer left it.
const toggleCoachCollapsed = () => {
 setCoachCollapsed((prev) => {
  const next = !prev
  try {
   window.localStorage.setItem('better-writer:coach-collapsed', next ? '1' : '0')
  } catch {
   // Storage disabled: fail soft — the choice just doesn't survive reloads.
  }
  return next
 })
}

// Swap the app theme (applied to <html data-theme> by useTheme's setter).
const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark')

// Zero-padded HH:MM in local time for the save indicator.
const formatClock = (date: Date) => {
 const hh = String(date.getHours()).padStart(2, '0')
 const mm = String(date.getMinutes()).padStart(2, '0')
 return `${hh}:${mm}`
}

const toggleDictation = async () => {
  if (dictationState === 'transcribing') return
  if (dictationState === 'recording') {
   recorderRef.current?.stop() // onstop -> transcribe
   return
  }
  setError(null)
  try {
   const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
   const mimeType = pickRecordingMimeType()
   const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream)
   recorderRef.current = recorder
   chunksRef.current = []
   recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunksRef.current.push(event.data)
   }
   recorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop())
    const blob = new Blob(chunksRef.current, { type: mimeType ?? 'audio/webm' })
    setDictationState('transcribing')
    // Transport is chosen at STOP time: the recorder may have started in one
    // mode and stopped after the writer switched (e.g. BYOK saved mid-recording).
    // Local sends the WAV to the server's /transcribe; BYOK sends the same bytes
    // to the writer's provider's /audio/transcriptions.
    void (modeRef.current === 'local' ? transcribeAudio(blob) : transcribeWavByok(blob))
     .then((text) => {
      if (text.trim()) editorAccess.insertAtCursor(text.trimEnd() + ' ')
     })
     .catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
     })
     .finally(() => setDictationState('idle'))
   }
   recorder.start()
   setDictationState('recording')
  } catch (err) {
   setError(err instanceof Error ? err.message : String(err))
  }
 }

 // Sweep the WHOLE draft: plan non-overlapping windows, then run them one at
 // a time. Each note renders the moment its own ask resolves (progressive);
 // if one ask throws, runSweep aborts and the error surfaces here.
 const sweepDraft = async () => {
  const coach = coachRef.current
  if (!coach || sweeping) return
  const fullText = draftRef.current
  if (!fullText.trim()) {
   setError('There is no text yet — write something first.')
   return
  }
  abortSweepRef.current = false
  sweepingRef.current = true
  setSweeping(true)
  // A new sweep supersedes the last sweep's summary.
  setSweepSummary(null)
  setError(null)
  try {
   const plan = planSweep(fullText)
   const result = await runSweep(plan, {
    genre: genreRef.current,
    coach,
    draft: fullText,
    onProgress: (done, total) => setProgress({ done, total }),
    shouldAbort: () => abortSweepRef.current,
    onNote: (note) => {
     const record: AnchorRecord = makeNote(
      { start: note.start, end: note.end, fragment: note.fragment },
      note.question,
      note.ts,
     )
     // Attach the note's provenance when the sweep reported one, so the
     // topic-probe chip can label honest questions. Persisted shape stays
     // backward compatible: source is an optional field.
     if (note.source) record.source = note.source
     // Append and persist incrementally, so a reload mid-sweep keeps
     // what arrived before it.
     annotationsRef.current = [...annotationsRef.current, record]
     setSweepNotes((prev) => [...prev, record])
    void coordinator.persistNow(draftRef.current, annotationsRef.current)
    },
   })
   // pinned = notes actually anchored (SweepResult counts asked === notes.length).
   setSweepSummary({
    asked: result.asked,
    skipped: result.skipped,
    pinned: result.notes.length,
   })
  } catch (err) {
   setError(err instanceof Error ? err.message : String(err))
  } finally {
   sweepingRef.current = false
   setSweeping(false)
   setProgress(null)
  }
 }

 // Wipe every annotation.
 const clearNotes = () => {
  setSweepNotes([])
  annotationsRef.current = []
  // Clearing every note also retires the last sweep's summary.
  setSweepSummary(null)
 void coordinator.persistNow(draftRef.current, [])
 }

 // Remove exactly one note, matched by its (start, end, ts) identity triple,
 // from the screen and from persisted storage.
 const resolveNote = (note: AnchorRecord) => {
  const isSameNote = (a: AnchorRecord) => sameNote(a, note)
  annotationsRef.current = annotationsRef.current.filter((a) => !isSameNote(a))
  setSweepNotes((prev) => prev.filter((n) => !isSameNote(n)))
  void coordinator.persistNow(draftRef.current, annotationsRef.current)
 }

 // BYOK panel: seed the form from the saved config on open (or fall back to
 // the openrouter preset when nothing is configured yet), then toggle open.
 const openByokPanel = () => {
  if (byokOpen) {
   setByokOpen(false)
   return
  }
  const cfg = loadByokConfig()
  setByokForm(
   cfg
    ? {
       provider: cfg.provider as Provider,
       baseUrl: cfg.baseUrl,
       model: cfg.model,
       apiKey: cfg.apiKey,
      }
    : { provider: 'openrouter', baseUrl: PRESETS.openrouter, model: '', apiKey: '' },
  )
  setByokOpen(true)
 }

 // Switching to a preset provider prefills its base URL (and locks the field
 // against editing); custom leaves the URL to the writer. Model and key are
 // untouched — the writer's half-typed values survive a provider change.
 const handleProviderChange = (next: Provider) => {
  setByokForm((f) => ({
   ...f,
   provider: next,
   baseUrl: next === 'custom' ? f.baseUrl : PRESETS[next],
  }))
 }

 // Persist the config and adopt byok immediately — the same path as detection
 // (new ByokCoach + makeDraftStore('byok'), which is a LocalStorageDraftStore
 // per the store's ternary), plus a draft reload so prose saved under static
 // mode surfaces. No page reload: the writer keeps working.
 const saveByokSettings = () => {
  const { provider, baseUrl, model, apiKey } = byokForm
  if (!baseUrl.trim() || !model.trim() || !apiKey.trim()) {
   setError(
    provider === 'custom'
     ? 'A custom provider needs a base URL, model, and API key.'
     : 'All fields are required — model and API key at minimum.',
   )
   return
  }
 // Same policy loadByokConfig applies on read — an unsafe URL would persist
 // here and then silently disconnect on the next ask, so reject it now.
 if (!isValidBaseUrl(baseUrl.trim().replace(/\/+$/, ''))) {
  setError(
   'That base URL is not safe to send a key to: use https, or http only for localhost/127.0.0.1.',
  )
  return
 }
  saveByokConfig({
   provider,
   baseUrl: baseUrl.trim().replace(/\/+$/, ''),
   apiKey: apiKey.trim(),
   model: model.trim(),
  })
  coachRef.current = new ByokCoach()
  draftStoreRef.current = makeDraftStore('byok')
  setMode('byok')
  loadDraftAndNotes(draftStoreRef.current)
  setByokOpen(false)
 }

 // Clear the config and return to the static demo: StaticCoach +
 // LocalStorageDraftStore (makeDraftStore('static') — its ternary only routes
 // 'local' to the server), with the same draft reload as adoption.
 const disconnectByok = () => {
  saveByokConfig(null)
  coachRef.current = makeCoach('static')
  draftStoreRef.current = makeDraftStore('static')
  setMode('static')
  loadDraftAndNotes(draftStoreRef.current)
  setByokOpen(false)
 }

 const dictationLabel =
  dictationState === 'recording' ? 'Stop recording' : dictationState === 'transcribing' ? 'Transcribing…' : 'Dictate'

 // Dictation availability, derived per render: always on for the local server
 // (its Parakeet via /transcribe), and for BYOK only when the provider can
 // take audio (openrouter cannot) AND a dictation model resolves. Reading the
 // config here each render means saving BYOK settings re-evaluates this
 // immediately, so the button appears as soon as a usable provider is set.
 const byokCfg = mode === 'byok' ? loadByokConfig() : null
 const dictationAvailable =
  mode === 'local' ||
  (byokCfg !== null &&
   TRANSCRIBES_AUDIO[byokCfg.provider as Provider] &&
   sttModelFor(byokCfg) !== null)

 // Pre-flight cost estimate for the Sweep button: once the draft spans six or
 // more windows, tell the writer how many questions it will ask. planSweep is
 // pure and fast, so an inline per-render computation is acceptable.
 const sweepEstimate =
  isModelBacked(mode) && draftRef.current.trim() !== '' && !sweeping ? planSweep(draftRef.current).length : 0
 const sweepTitle =
  sweepEstimate >= 6
   ? `Ask ~${sweepEstimate} questions across the whole draft`
   : 'Ask one coach question per window across the whole draft'

 // Sweep draft runs for any model-backed mode: local (server model) and byok
// (browser provider) both reshape one question per window, so the control
// gates on isModelBacked, not mode === 'local'.
const sweepControls = isModelBacked(mode) && (
  <>
   {sweeping ? (
    <>
     <span className="coach-sweep-status" aria-live="polite">
      Asking {progress ? Math.min(progress.done + 1, progress.total) : '?'} of {progress?.total ?? '?'} …
     </span>
     <button
      className="coach-cancel coach-sweep"
      onClick={() => {
       abortSweepRef.current = true
      }}
      title="Stop after the current window"
     >
      Stop
     </button>
    </>
   ) : (
    <button
     className="coach-sweep"
     onClick={() => void sweepDraft()}
     disabled={sweeping}
     title={sweepTitle}
    >
     Sweep draft
    </button>
   )}
   <button
    className="coach-clear"
    onClick={clearNotes}
    disabled={sweepNotes.length === 0 || sweeping}
    title="Remove all annotations"
   >
    Clear notes
   </button>
  </>
 )

  return (
 <div className="app">
   <header className="topbar">
    <span className="app-title">Better Writer</span>
    {mode !== 'detecting' && (
     <span className={`mode-badge mode-${mode}`} title={`${mode} coach and draft store`}>
      {mode}
     </span>
    )}
     {/* Preview toggle: cycles off → split → full → off. 'split' shows the
      rendered pane LIVE beside the editor; 'full' swaps the cm host for the
      pane in the SAME layout slot (editor hidden via display:none, never
      unmounted, so undo/caret/history survive). Label/title name the NEXT
      action the button will perform. */}
  <button
   className={`preview-toggle ${previewMode !== 'off' ? 'is-open' : ''}`}
   onClick={cyclePreview}
   title={nextPreviewLabel}
   aria-label={nextPreviewLabel}
   aria-pressed={previewMode !== 'off'}
  >
   {previewMode === 'off' ? (
    <Eye size={14} />
   ) : previewMode === 'split' ? (
    <Expand size={14} />
   ) : (
    <EyeOff size={14} />
   )}
   {previewMode === 'off' ? 'Preview' : previewMode === 'split' ? 'Split' : 'Edit'}
  </button>
   {/* Theme toggle: flips <html data-theme> (dark/light). Sun in dark mode
       (click for light), Moon in light mode. Same family as Preview/BYOK. */}
   <button
    className="theme-toggle"
    onClick={toggleTheme}
    title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
   >
    {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
    {theme === 'dark' ? 'Light' : 'Dark'}
   </button>
    {/* BYOK bring-your-own-key: shown whenever a non-local, non-detecting mode
        is active — static (offer to connect) and byok (already connected). The
        panel drops under the toggle; it never renders while detecting. */}
    {(mode === 'static' || mode === 'byok') && (
     <div className="byok-wrap">
      <button
       className={`byok-toggle ${byokOpen ? 'is-open' : ''}`}
       onClick={openByokPanel}
       title={mode === 'byok' ? 'BYOK provider settings' : 'Connect your own API key'}
      >
       BYOK
      </button>
      {byokOpen && (
       <div className="byok-panel" role="dialog" aria-label="BYOK provider settings">
        <label className="byok-field">
         <span className="byok-label">Provider</span>
         <select
          className="genre-select"
          value={byokForm.provider}
          onChange={(e) => handleProviderChange(e.target.value as Provider)}
         >
          <option value="openrouter">openrouter</option>
          <option value="openai">openai</option>
          <option value="groq">groq</option>
          <option value="custom">custom</option>
         </select>
        </label>
        <label className="byok-field">
         <span className="byok-label">Base URL</span>
         <input
          type="text"
          className="byok-input"
          value={byokForm.baseUrl}
          disabled={byokForm.provider !== 'custom'}
          onChange={(e) => setByokForm((f) => ({ ...f, baseUrl: e.target.value }))}
          placeholder={PRESETS[byokForm.provider]}
         />
        </label>
        <label className="byok-field">
         <span className="byok-label">Model</span>
         <input
          type="text"
          className="byok-input"
          value={byokForm.model}
          onChange={(e) => setByokForm((f) => ({ ...f, model: e.target.value }))}
          placeholder={MODEL_PLACEHOLDERS[byokForm.provider]}
         />
        </label>
        <label className="byok-field">
         <span className="byok-label">API key</span>
         <input
          type="password"
          className="byok-input"
          value={byokForm.apiKey}
          autoComplete="off"
          onChange={(e) => setByokForm((f) => ({ ...f, apiKey: e.target.value }))}
          placeholder="sk-…"
         />
        </label>
        <div className="byok-actions">
         <button className="byok-save" onClick={saveByokSettings}>
          Save
         </button>
         {mode === 'byok' && (
          <button className="byok-disconnect" onClick={disconnectByok}>
           Disconnect
          </button>
         )}
         <button className="byok-close" onClick={() => setByokOpen(false)}>
          Close
         </button>
        </div>
       </div>
      )}
     </div>
    )}
       {saveDisplay !== 'idle' && (
    // Right of the mode badge: the debounced save pulse. 'Saving…' only once
    // a save lingers past its pending window; 'Saved HH:MM' sticks for the
    // sticky window then reverts to idle (see save-indicator.ts).
    <span className="save-status" aria-live="polite">
     {saveDisplay === 'saving' ? 'Saving…' : saveTime ? `Saved ${formatClock(saveTime)}` : 'Saved'}
    </span>
   )}
   </header>

     <main className="editor-container">
   <div className={`editor-wrapper ${previewMode === 'split' ? 'is-split' : ''}`}>
    {/* The host is HIDDEN (display:none via .is-hidden) only in 'full'; in
        'off' and 'split' it is visible and click delegation stays live (the
        editor is on screen, so highlight clicks resolve normally). Never
        unmounts — the undo stack/caret/history survive every mode change. */}
    <div
     className={`editor-host ${previewMode === 'full' ? 'is-hidden' : ''}`}
     onClick={previewMode === 'full' ? undefined : handleHighlightClick}
    >
     <CodeMirrorHost
      editorAccess={editorAccess}
      initialText={draft}
      onDocChange={handleContentChange}
      onViewportChange={() => setViewportTick((t) => t + 1)}
     />
    </div>
    {(previewMode === 'split' || previewMode === 'full') && <MarkdownPreview text={draft} />}
    {previewMode !== 'full' &&
      sweepNotes.map((note) => {
       const id = noteId(note)
       return (
        <HighlightOverlay
         key={id}
         anchor={{ start: note.start, end: note.end }}
         question={note.question}
         source={note.source}
         rectForRange={editorAccess.rectForRange}
         viewportTick={viewportTick}
         noteId={id}
         activeId={openNoteId}
         onResolve={() => resolveNote(note)}
         openOnClickOnly
        />
       )
      })}
    </div>

    {error && (
     <div className="error-toast" role="alert">
      <span>{error}</span>
      <button className="error-dismiss" onClick={() => setError(null)} aria-label="Dismiss error">
       <X size={12} />
      </button>
     </div>
    )}

    {/* Dictation routes the recorded WAV to whatever transcription the current
        mode can provide: local posts the bytes to the server's /transcribe
        (its Parakeet); BYOK posts the same bytes to the writer's provider's
        /audio/transcriptions. Hidden only when the provider can't take audio
        (openrouter) or no STT model resolves. */}
    {dictationAvailable && (
     <div className="editor-controls">
      <button
       className={`dictate-button ${dictationState}`}
       onClick={() => void toggleDictation()}
       disabled={dictationState === 'transcribing'}
       title={dictationLabel}
      >
       {dictationState === 'recording' ? <MicOff size={16} /> : <Mic size={16} />}
       {dictationState === 'recording'
        ? 'Stop'
        : dictationState === 'transcribing'
         ? 'Transcribing…'
         : 'Dictate'}
      </button>
     </div>
    )}

       <section
    className={`coach-panel ${coachCollapsed ? 'is-collapsed' : ''}`}
    aria-label="Writing coach"
   >
    {/* Slim header bar: title + chevron. Collapsing hides the body below and
        leaves just this bar (state persisted in better-writer:coach-collapsed). */}
    <button
     className="coach-toggle"
     onClick={toggleCoachCollapsed}
     aria-expanded={!coachCollapsed}
     aria-controls="coach-body"
     title={coachCollapsed ? 'Expand coach panel' : 'Collapse coach panel'}
    >
     <span>Coach</span>
     <span className="coach-toggle-icon" aria-hidden="true">
      {coachCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
     </span>
    </button>
    {!coachCollapsed && (
     <div id="coach-body" className="coach-body">
      {sweepNotes.length > 0 ? (
      <>
       {/* The inbox tray: every pinned note, with a per-row jump + resolve. */}
       <InboxPanel
        notes={sweepNotes}
        focusNoteId={openNoteId}
        onFocusNote={handleFocusNote}
        onResolveNote={resolveNote}
       />
       <span className="coach-count">{sweepNotes.length} pinned</span>
      </>
     ) : (
      <p className="coach-placeholder">Sweep the draft for craft notes.</p>
     )}
     {/* Sample loader: only while the page is empty (mode known, no draft, not
         yet loaded once). Loading a sample writes it straight into the draft
         and the coordinator — the sweep then has real prose to chew on. */}
     {mode !== 'detecting' && draftRef.current.trim() === '' && !sampleLoaded && (
      <button
       className="sample-load"
       onClick={() => {
        // Buffer write through the seam, with a true history reset (C3): the
        // sample replaces the empty page wholesale and undo can never wipe it.
        editorAccess.replaceDocument(SAMPLE_DRAFT, { history: 'reset' })
        draftRef.current = SAMPLE_DRAFT
        // The reset path does NOT fire onDocChange, so handleContentChange
        // never runs — sync React state explicitly here, and let the
        // coordinator persist the loaded draft as before.
        setDraft(SAMPLE_DRAFT)
        coordinator.edit(SAMPLE_DRAFT, annotationsRef.current)
        setSampleLoaded(true)
       }}
       title="Replace the empty page with example prose you can sweep"
      >
       Load a sample draft
      </button>
     )}
     {/* Sweep outcome, above the actions: STAYS visible after completion (not
         a toast), cleared on the next sweep or a full clear. */}
     {sweepSummary && (
      <p
       className="coach-summary"
       title="Skips are windows whose answer didn't anchor to a span in the draft."
      >
       {sweepSummary.skipped > 0
        ? `Pinned ${sweepSummary.pinned} · skipped ${sweepSummary.skipped}.`
        : `Pinned ${sweepSummary.pinned}.`}
      </p>
     )}
         <div className="coach-actions">
     {/* Row 1: genre picker + auto-ask. Deliberate pairing so they never
         strand a control on its own wrapped line. */}
     <div className="coach-actions-row">
      <label className="genre-inline-field" title="Genre steers which seed the coach pulls">
       <span className="genre-label">asking as</span>
       <select
        className="genre-select genre-inline"
        value={genre}
        onChange={(e) => handleGenreChange(e.target.value as Genre)}
       >
        {GENRES.map((g) => (
         <option key={g} value={g}>
          {g}
         </option>
        ))}
       </select>
      </label>
      {/* Auto-ask stays gated on mode === 'local', NOT modelBacked: a
          background question must not spend the writer's BYOK tokens — only
          the local server's free model may fire unprompted. Deliberate. */}
      {mode === 'local' && (
       <label className="cadence-toggle" title="Ask one coach question automatically when the draft pauses after growing">
        <span>Auto-ask</span>
        <input
         type="checkbox"
         checked={!cadencePaused}
         onChange={(e) => {
          const paused = !e.target.checked
          cadencePausedRef.current = paused
          setCadencePaused(paused)
          // Re-arm on toggle so un-pausing never fires an immediate question.
          cadence.reset(draftRef.current)
         }}
        />
       </label>
      )}
     </div>
     {/* Row 2: sweep + clear together, so the footer never strands one. */}
     {isModelBacked(mode) && <div className="coach-actions-row">{sweepControls}</div>}
    </div>
     </div>
    )}
    </section>
   </main>
  </div>
 )
}
