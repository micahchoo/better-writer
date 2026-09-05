import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Expand, Eye, EyeOff, Mic, MicOff, Moon, Sun, X } from 'lucide-react'
import { GENRES, type Genre, type CoachInput } from '../src/core/types'
import { extractAnchor } from './anchor'
import { createCadence, type Cadence } from './cadence'
import { planSweep, cursorPlan } from './coach-sweep'
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
import { makeDraftStore, type AnchorRecord } from './draft-store'
import { makeNote, noteId } from './notes'
import { pickRecordingMimeType, transcribeAudio } from './dictation'
import { HighlightOverlay, noteFromMark } from './highlight'
import { InboxPanel } from './inbox-panel'
import { MarkdownPreview } from './markdown-preview'
import { SAMPLE_DRAFT } from './sample-draft'
import { parseCoachResult } from '../src/core/contract'
import { DocumentSession, type DocumentSnapshot } from './document-session'
import { CoachingSession, type CoachingState } from './coaching-session'
import type { Transaction } from '@codemirror/state'
import type { TextChange } from './annotations'
import { SaveIndicator, type SaveIndicatorDisplay } from './save-indicator'
import { useTheme } from './theme'

// Model-field hints per provider — placeholders only, never written to the
// saved config. The writer supplies the real model at save time.
const MODEL_PLACEHOLDERS: Record<Provider, string> = {
 openrouter: 'openai/gpt-4o-mini',
 openai: 'gpt-4o-mini',
 groq: 'meta-llama/llama-3.3-70b-instruct',
 custom: 'e.g. your-model-id',
}
export default function EditorApp() {
 const [mode, setMode] = useState<CoachMode | 'detecting'>('detecting')
 // App theme owned by <html data-theme> (see theme.ts): useTheme applies the
 // theme to the root element and persists the toggle; CSS and the CM editor
 // read the same var(--token) values, so a swap restyles instantly.
 const [theme, setTheme] = useTheme()
 const [documentState, setDocumentState] = useState<DocumentSnapshot>({ id: '', revision: 0, draft: '', notes: [], ready: false })
 const draft = documentState.draft
 const sweepNotes = documentState.notes
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
 const [coachingState, setCoachingState] = useState<CoachingState>('idle')
 const sweeping = coachingState === 'sweeping'
 // Sweep progress: completed window count over the plan length, null when idle.
 const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
 // Sweep notes on screen: one highlight per note across the whole draft.
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
  unavailable: number
  noFit: number
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
  sttModel: string
 }>({ provider: 'openrouter', baseUrl: PRESETS.openrouter, model: '', apiKey: '', sttModel: '' })
 // Bumped on BYOK save/disconnect so the memoized config read (byokCfg below)
 // re-evaluates: the settings round-trip must invalidate the cached
 // localStorage read instead of waiting for a mode change.
 const [byokCfgVersion, setByokCfgVersion] = useState(0)
 // Tri-mode rendered preview. Split is the DEFAULT (side-by-side on load; no
// persistence — every fresh load starts split, the user cycles from there).
// 'off' edits full-width; 'split' shows the rendered pane LIVE beside the
// editor (the renderer debounces ~250ms inside markdown-preview.tsx so
// keystrokes never pay an O(doc) pass); 'full' hides the cm host VISUALLY
// (className swap to display:none — never unmounts it) so the undo stack,
// caret, and history survive the round-trip; the editor stays live and keeps
// dispatching even while hidden. `draft` is the source of truth for the pane.
const PREVIEW_CYCLE = ['off', 'split', 'full'] as const
const [previewMode, setPreviewMode] = useState<'off' | 'split' | 'full'>('split')
const cyclePreview = () =>
 setPreviewMode((m) => PREVIEW_CYCLE[(PREVIEW_CYCLE.indexOf(m) + 1) % PREVIEW_CYCLE.length])
// The toggle's label names the NEXT action: off→split, split→full, full→off.
const nextPreviewLabel =
 previewMode === 'off' ? 'Show split preview' : previewMode === 'split' ? 'Expand preview' : 'Back to editing'

 const documentRef = useRef<DocumentSession | null>(null)
 const coachingRef = useRef<CoachingSession | null>(null)
 const connectionGenerationRef = useRef(0)
 const pendingTextRef = useRef<string | null>(null)
 const genreRef = useRef<Genre>(genre)
 const recorderRef = useRef<MediaRecorder | null>(null)
 const chunksRef = useRef<Blob[]>([])
 const mountedRef = useRef(false)
 // Cadence state machine (cadence.ts). Lazy-initialized through useRef so
 // re-renders never rebuild the machine; the 5s poll closure reads this ref.
 const cadenceRef = useRef<Cadence | null>(null)
 if (cadenceRef.current === null) cadenceRef.current = createCadence()
 const cadence = cadenceRef.current
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

 // Storage is selected once when the document opens. Changing a model
 // connection never reloads the document or changes its save destination.
 useEffect(() => {
  let cancelled = false
  mountedRef.current = true
  const connectionGeneration = connectionGenerationRef.current
  const configured = loadByokConfig()
  const unavailable: Coach = { ask: async () => ({ kind: 'unavailable', retryable: false }) }
  const coaching = new CoachingSession(configured ? new ByokCoach({ config: configured }) : unavailable, {
   onState: setCoachingState,
  })
  coachingRef.current = coaching
  if (configured) setMode('byok')
  void detectServerMode().then(async detected => {
   if (cancelled) return
   // A configuration saved while detection was pending also takes priority.
   if (connectionGeneration === connectionGenerationRef.current && !configured) {
    coaching.configure(makeCoach(detected))
    setMode(detected)
   }
   let storage: 'browser' | 'server' = configured ? 'browser' : detected === 'local' ? 'server' : 'browser'
   try {
    const saved = localStorage.getItem('better-writer:document-storage')
    if (saved === 'browser' || saved === 'server') storage = saved
    localStorage.setItem('better-writer:document-storage', storage)
   } catch { /* Storage choice can still live for this session. */ }
   const session = new DocumentSession(makeDraftStore(storage), {
    onChange: setDocumentState,
    onError: err => { setError(err instanceof Error ? err.message : String(err)); saveIndicator.saveFailed() },
    onSaveState: phase => {
     if (phase === 'saving') saveIndicator.saveStarted()
     else { saveIndicator.saveSucceeded(); setSaveTime(new Date()) }
    },
   })
   documentRef.current = session
   if (pendingTextRef.current !== null) session.edit(pendingTextRef.current)
   await session.load()
   if (!cancelled) {
    editorAccess.replaceDocument(session.snapshot.draft, { history: 'reset' })
    cadence.reset(session.snapshot.draft)
   }
  })
  const flush = () => { void documentRef.current?.flush({ keepalive: true }) }
  document.addEventListener('visibilitychange', flush)
  window.addEventListener('pagehide', flush)
  return () => {
   cancelled = true
   mountedRef.current = false
   document.removeEventListener('visibilitychange', flush)
   window.removeEventListener('pagehide', flush)
   coaching.dispose()
   const session = documentRef.current
   void session?.flush()
   session?.dispose()
   documentRef.current = null
   coachingRef.current = null
   saveIndicator.dispose()
   if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }
 }, [])

// Auto-ask poll: cadence re-checks every 5 s even with no further typing, so
// a draft that grew past the threshold and then went quiet still fires while
// the writer reads. Session state is read at each tick.
useEffect(() => {
 const timer = window.setInterval(() => {
  maybeFireCadence(documentRef.current?.snapshot.draft ?? '')
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

const handleContentChange = (value: string, transactions?: readonly Transaction[]) => {
 const session = documentRef.current
 if (!session) {
  pendingTextRef.current = value
  setDocumentState(previous => ({ ...previous, draft: value }))
  return
 }
 if (transactions?.length) {
  for (const transaction of transactions) {
   if (!transaction.docChanged) continue
   const changes: TextChange[] = []
   transaction.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    changes.push({ from, to, insert: inserted.toString() })
   })
   session.edit(transaction.newDoc.toString(), changes)
  }
 } else session.edit(value)
 maybeFireCadence(value)
}

const maybeFireCadence = (text: string) => {
 if (cadence.observe(text) === 'ready' && mayAutoAsk(modeRef.current) &&
     coachingRef.current?.state === 'idle' && documentRef.current?.snapshot.ready && !cadencePausedRef.current) {
  void askCursorWindow()
 }
}

const askCursorWindow = async () => {
 const session = documentRef.current
 const coaching = coachingRef.current
 if (!session || !coaching) return
 const captured = session.capture()
 const caretOffset = editorAccess.readCursor()?.offset ?? Math.floor(captured.draft.length / 2)
 const window = cursorPlan(captured.draft, caretOffset)
 if (!window) { cadence.reset(captured.draft); return }
 // Reset at dispatch, so cancellation cannot let an old completion reset
 // the cadence of a newer run.
 cadence.reset(captured.draft)
 try {
  const input: CoachInput = { textWindow: window.textWindow, focus: window.focus, position: window.position,
   genre: genreRef.current, cursorOffset: caretOffset }
  const answer = await coaching.ask(input)
  const result = answer?.kind === 'question' && answer.source === 'reshaped' ? parseCoachResult(answer, input) : answer
  if (!result || result.kind !== 'question') return
  const anchor = result.evidence
   ? { start: window.bounds.start + result.evidence.start, end: window.bounds.start + result.evidence.end, fragment: result.evidence.quote }
   : result.source === 'seed' ? extractAnchor(result.question, captured.draft, caretOffset) : null
  if (anchor) {
   const note = makeNote(anchor, result.question, Date.now(), captured.draft)
   note.source = result.source
   session.add(note, captured)
  }
 } catch { /* Automatic coaching stays quiet when unavailable. */ }
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
 coachingRef.current?.cancel()
 setProgress(null)
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
   const recordingMode = modeRef.current
   const recordingConfig = loadByokConfig()
   const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
   if (!mountedRef.current) { stream.getTracks().forEach(track => track.stop()); return }
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
    if (!mountedRef.current) return
    const blob = new Blob(chunksRef.current, { type: mimeType ?? 'audio/webm' })
    setDictationState('transcribing')
    // Keep the connection captured when recording began.
    void (recordingMode === 'local' ? transcribeAudio(blob) : transcribeWavByok(blob, recordingConfig))
     .then((text) => {
      if (mountedRef.current && text.trim()) editorAccess.insertAtCursor(text.trimEnd() + ' ')
     })
     .catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
     })
     .finally(() => { if (mountedRef.current) setDictationState('idle') })
   }
   recorder.start()
   setDictationState('recording')
  } catch (err) {
   setError(err instanceof Error ? err.message : String(err))
  }
 }

 const sweepDraft = async () => {
  const session = documentRef.current
  const coaching = coachingRef.current
  if (!session || !coaching || coaching.state === 'sweeping') return
  const captured = session.capture()
  if (!captured.draft.trim()) { setError('There is no text yet — write something first.'); return }
  setSweepSummary(null)
  setError(null)
  let pinned = 0
  try {
   const result = await coaching.sweep(planSweep(captured.draft), {
    genre: genreRef.current, draft: captured.draft,
    onProgress: (done, total) => setProgress({ done, total }),
    onNote: note => {
     const record = makeNote(note, note.question, note.ts, captured.draft)
     record.source = note.source
     if (session.add(record, captured)) pinned++
    },
   })
   if (result) {
    setSweepSummary({ asked: result.requested, skipped: result.skipped + result.asked - pinned, pinned, unavailable: result.unavailable, noFit: result.noFit })
    setProgress(null)
   }
  } catch (err) {
   if (mountedRef.current) { setError(err instanceof Error ? err.message : String(err)); setProgress(null) }
  }
 }

 const clearNotes = () => {
  coachingRef.current?.cancel()
  documentRef.current?.clear()
  setSweepSummary(null)
  setProgress(null)
 }
 const resolveNote = (note: AnchorRecord) => {
  documentRef.current?.resolve(note)
  if (openNoteId === noteId(note)) setOpenNoteId(null)
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
       // Seed the effective dictation model (explicit override wins over the
       // provider default) so the field shows what will actually be used, and
       // saving it back makes the override explicit rather than erasing it.
       sttModel: sttModelFor(cfg) ?? '',
      }
    : { provider: 'openrouter', baseUrl: PRESETS.openrouter, model: '', apiKey: '', sttModel: '' },
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

 // Reconfigure coaching while keeping the current document session.
 const saveByokSettings = () => {
  const { provider, baseUrl, model, apiKey, sttModel } = byokForm
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
   // Dictation model is optional: persist it only when set, so an empty field
   // degrades to the provider default (sanitize drops empty sttModel anyway).
   ...(sttModel.trim() !== '' ? { sttModel: sttModel.trim() } : {}),
  })
  connectionGenerationRef.current++
  coachingRef.current?.configure(new ByokCoach())
  setProgress(null)
  setSweepSummary(null)
  // Bump the config cache so dictation availability re-evaluates immediately.
  setByokCfgVersion((v) => v + 1)
  setMode('byok')
  setByokOpen(false)
 }

 // Disconnect the paid provider without reopening the document.
 const disconnectByok = () => {
  saveByokConfig(null)
  connectionGenerationRef.current++
  coachingRef.current?.configure(makeCoach('static'))
  setProgress(null)
  setSweepSummary(null)
  setByokCfgVersion((v) => v + 1)
  setMode('static')
  setByokOpen(false)
 }

 const dictationLabel =
  dictationState === 'recording' ? 'Stop recording' : dictationState === 'transcribing' ? 'Transcribing…' : 'Dictate'

 // Dictation availability: always on for the local server (its Parakeet via
 // /transcribe), and for BYOK only when the provider can take audio
 // (openrouter cannot) AND a dictation model resolves. The config is read once
 // per (mode, byokCfgVersion) pair and cached — NOT on every render — so the
 // keystroke hot path never pays a localStorage read + JSON.parse. Saving or
 // disconnecting BYOK bumps byokCfgVersion, so the button appears as soon as a
 // usable provider is set without a full reload.
 const byokCfg = useMemo(
  () => (mode === 'byok' ? loadByokConfig() : null),
  [mode, byokCfgVersion],
 )
 const dictationAvailable =
  mode === 'local' ||
  (byokCfg !== null &&
   TRANSCRIBES_AUDIO[byokCfg.provider as Provider] &&
   sttModelFor(byokCfg) !== null)

 // Pre-flight cost estimate for the Sweep button: once the draft spans six or
 // more windows, tell the writer how many questions it will ask. Memoized on
 // the draft/mode/sweeping it actually reads so unrelated re-renders (theme,
 // viewport ticks, popover state) never re-run planSweep's O(doc) pass.
 const sweepEstimate = useMemo(() => {
  if (!isModelBacked(mode) || draft.trim() === '' || sweeping) return 0
  return planSweep(draft).length
 }, [mode, draft, sweeping])
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
       coachingRef.current?.cancel()
       setProgress(null)
      }}
      title="Cancel pending questions"
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
     {/* Model connections are independent of document storage. */}
     {mode !== 'detecting' && (
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
          <span className="byok-label">Dictation model</span>
          <input
           type="text"
           className="byok-input"
           value={byokForm.sttModel}
           onChange={(e) => setByokForm((f) => ({ ...f, sttModel: e.target.value }))}
           placeholder="optional — e.g. whisper-1"
           title="Optional STT model for dictation; blank uses the provider default"
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
         and its document session. */}
     {documentState.ready && draft.trim() === '' && !sampleLoaded && (
      <button
       className="sample-load"
       onClick={() => {
        // Buffer write through the seam, with a true history reset (C3): the
        // sample replaces the empty page wholesale and undo can never wipe it.
        editorAccess.replaceDocument(SAMPLE_DRAFT, { history: 'reset' })
        documentRef.current?.edit(SAMPLE_DRAFT)
        cadence.reset(SAMPLE_DRAFT)
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
       title="A window may have no suitable question, invalid evidence, or an unavailable model."
      >
       {sweepSummary.unavailable > 0 ? `Coach unavailable for ${sweepSummary.unavailable} windows. ` : ''}
       {sweepSummary.pinned === 0 && sweepSummary.noFit > 0 ? 'No suitable question found. ' : ''}
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
      {/* The Auto-ask checkbox is visible in EVERY mode that may auto-ask —
          static and local (both free per mayAutoAsk). A background question
          must never spend the writer's BYOK tokens, so byok (and detecting,
          which has no coach yet) never render the toggle and the timer never
          fires there. Static MUST show it: static has no Sweep control, so
          the cadence timer is its only path to a question, and the toggle is
          the only way to pause it. */}
      {mayAutoAsk(mode) && (
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
          cadence.reset(documentRef.current?.snapshot.draft ?? '')
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
