import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import MDEditor from '@uiw/react-md-editor'
import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import { Mic, MicOff, X } from 'lucide-react'
import { GENRES, type Genre } from '../src/types'
import { extractAnchor } from './anchor'
import { createCadence, type Cadence } from './cadence'
import { planSweep, runSweep, staleAnnotations } from './coach-sweep'
import { detectServerMode, makeCoach, type Coach, type CoachMode } from './coach'
import { createEditorAccess } from './editor-access'
import { makeDraftStore, type AnchorRecord, type DraftStore } from './draft-store'
import { makeNote, noteId, sameNote } from './notes'
import { pickRecordingMimeType, transcribeAudio } from './dictation'
import { HighlightOverlay } from './highlight'
import { InboxPanel } from './inbox-panel'
import { SAMPLE_DRAFT } from './sample-draft'
import { SaveCoordinator } from './save-coordinator'
import { buildAskWindow, cursorWindow, splitBlocks } from './text-window'

export default function EditorApp() {
 const [mode, setMode] = useState<CoachMode | 'detecting'>('detecting')
 const [theme, setTheme] = useState<'light' | 'dark'>('light')
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
 // Save lifecycle pulse: 'saving' on send, 'saved' once the store confirms.
 // 'idle' until the first save ever. Deliberately never auto-reverts — a
 // completed save reads "Saved HH:MM" until the next save begins.
 const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
 // Wall-clock time of the last confirmed save, captured AT save-completion.
 const [saveTime, setSaveTime] = useState<Date | null>(null)
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

 const editorRef = useRef<ComponentRef<typeof MDEditor>>(null)
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
   setSaveState(phase)
   if (phase === 'saved') setSaveTime(new Date())
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
 // The editor wrapper: hosts the scrollport (.w-md-editor-area) that the
 // inbox "focus note" jump scrolls — the textarea itself never scrolls.
 const editorWrapperRef = useRef<HTMLDivElement>(null)

 // The one editor adapter, wired to the MDEditor ref (textarea surface —
 // react-md-editor v4 has no CodeMirror view; see editor-access.ts).
 const editorAccess = useMemo(
   () => createEditorAccess({ getTextarea: () => editorRef.current?.textarea ?? null }),
   [],
 )

 // Keep the overlay's textarea ref populated. Assigned during render (not in
 // an effect) so HighlightOverlay's layout effects see the element in the
 // same commit — a parent effect would run after the child's. This MUST be
 // a stable ref object: HighlightOverlay reads `textareaRef.current` both
 // inside its effects and in the render pass.
 const overlayTextareaRef = useRef<HTMLTextAreaElement | null>(null)
 overlayTextareaRef.current = editorRef.current?.textarea ?? null

 // Light/dark from the OS.
 useEffect(() => {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const updateTheme = (isDark: boolean) => setTheme(isDark ? 'dark' : 'light')
  updateTheme(mediaQuery.matches)
  const handleChange = (e: MediaQueryListEvent) => updateTheme(e.matches)
  mediaQuery.addEventListener('change', handleChange)
  return () => mediaQuery.removeEventListener('change', handleChange)
 }, [])

 // Mode detection: probe GET /health once. 200 JSON -> local mode
 // (LocalCoach + ServerDraftStore); anything else -> static demo
 // (StaticCoach + LocalStorageDraftStore). GitHub Pages is auto-static.
 useEffect(() => {
  let cancelled = false
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

 // Load the saved draft once the mode (and store) is known, then restore
 // every persisted annotation whose fragment still sits at its offsets.
 useEffect(() => {
  if (mode === 'detecting' || !draftStoreRef.current) return
  let cancelled = false
  void draftStoreRef.current
   .load()
   .then((text) => {
    if (!cancelled) {
     draftRef.current = text
     setDraft(text)
    }
    return draftStoreRef.current?.loadAnnotations() ?? Promise.resolve([])
   })
   .then((annotations) => {
    if (cancelled || annotations.length === 0) return
    const valid = staleAnnotations(annotations, draftRef.current) as AnchorRecord[]
    if (valid.length === 0) return
    annotationsRef.current = valid
    setSweepNotes(valid)
   })
   .catch((err: unknown) => {
    if (!cancelled) setError(err instanceof Error ? err.message : String(err))
   })
  return () => {
   cancelled = true
  }
 }, [mode])

// Unmount cleanup: cancel the coordinator's pending timers, stop any recording.
useEffect(() => {
 return () => {
  coordinator.dispose()
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

const handleContentChange = (value?: string) => {
 const text = value ?? ''
 draftRef.current = text
 setDraft(text)

 // Cadence: feed every change through the machine; if the draft grew past
 // the threshold AND the writer paused long enough, fire one auto-ask.
 maybeFireCadence(text)

// Strip any annotation whose fragment no longer sits at its recorded
 // offsets — a rewritten passage must not keep a stale highlight alive.
 const valid = staleAnnotations(annotationsRef.current, text) as AnchorRecord[]
 if (valid.length !== annotationsRef.current.length) {
  annotationsRef.current = valid
  setSweepNotes(valid)
  void coordinator.persistNow(text, valid)
 }

 // Debounced draft save, serialized through the coordinator.
 coordinator.edit(text, annotationsRef.current)
}

// The shared cadence driver used by BOTH the content-change handler and the
// 5 s poll. observe() is cheap and side-effect-free; firing is suppressed
// while a sweep runs or the writer paused the Auto-ask toggle.
const maybeFireCadence = (text: string) => {
 const phase = cadence.observe(text)
 if (phase === 'ready' && !sweepingRef.current && !cadencePausedRef.current) {
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
// scrollport so the anchored line is roughly centered. The scrollport is the
// package's .w-md-editor-area — the textarea itself is full-height and never
// scrolls. Line mapping is approximate: count newlines before the span times
// the textarea's line-height.
const handleFocusNote = (note: AnchorRecord) => {
 setOpenNoteId(noteId(note))
 const textarea = overlayTextareaRef.current
 const area = editorWrapperRef.current?.querySelector<HTMLElement>('.w-md-editor-area')
 if (!textarea || !area) return
 const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight || '21')
 const linesBefore = (draftRef.current.slice(0, note.start).match(/\n/g) ?? []).length
 const target = linesBefore * lineHeight - area.clientHeight * 0.35
 area.scrollTop = Math.max(0, Math.min(target, area.scrollHeight - area.clientHeight))
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
    void transcribeAudio(blob)
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

 const dictationLabel =
  dictationState === 'recording' ? 'Stop recording' : dictationState === 'transcribing' ? 'Transcribing…' : 'Dictate'

 // Pre-flight cost estimate for the Sweep button: once the draft spans six or
 // more windows, tell the writer how many questions it will ask. planSweep is
 // pure and fast, so an inline per-render computation is acceptable.
 const sweepEstimate =
  mode === 'local' && draftRef.current.trim() !== '' && !sweeping ? planSweep(draftRef.current).length : 0
 const sweepTitle =
  sweepEstimate >= 6
   ? `Ask ~${sweepEstimate} questions across the whole draft`
   : 'Ask one coach question per window across the whole draft'

 const sweepControls = mode === 'local' && (
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
  <div className={`app ${theme}`} data-color-mode={theme}>
   <header className="topbar">
    <span className="app-title">Better Writer</span>
    {mode !== 'detecting' && (
     <span className={`mode-badge mode-${mode}`} title={`${mode} coach and draft store`}>
      {mode}
     </span>
    )}
    {saveState !== 'idle' && (
     // Right of the mode badge: the save-lifecycle pulse. Nothing before the
     // first save; 'Saving…' while in flight, then the confirmed time. Never
     // auto-reverts (deliberate — no timers).
     <span className="save-status" aria-live="polite">
      {saveState === 'saving' ? 'Saving…' : saveTime ? `Saved ${formatClock(saveTime)}` : ''}
     </span>
    )}
   </header>

   <main className="editor-container">
    <div className="editor-wrapper" ref={editorWrapperRef}>
     <MDEditor
      ref={editorRef}
      value={draft}
      onChange={handleContentChange}
      data-color-mode={theme}
      visibleDragbar={false}
      hideToolbar
      preview="live"
      autoFocus
     />
     {sweepNotes.map((note) => {
      const id = noteId(note)
      return (
       <HighlightOverlay
        key={id}
        draft={draft}
        anchor={{ start: note.start, end: note.end }}
        question={note.question}
        source={note.source}
        cursorBlock={null}
        textareaRef={overlayTextareaRef}
        noteId={id}
        activeId={openNoteId}
        onOpenChange={setOpenNoteId}
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

    {mode === 'local' && (
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

    <section className="coach-panel" aria-label="Writing coach">
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
        draftRef.current = SAMPLE_DRAFT
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
      {/* Genre moved here, next to the ask controls: "asking as" reads
          naturally beside Sweep. Same persistence/state as before. */}
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
      {sweepControls}
     </div>
    </section>
   </main>
  </div>
 )
}
