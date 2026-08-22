import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import MDEditor from '@uiw/react-md-editor'
import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import { Mic, MicOff, X } from 'lucide-react'
import { GENRES, type Genre } from '../src/types'
import { planSweep, runSweep, staleAnnotations } from './coach-sweep'
import { detectServerMode, makeCoach, type Coach, type CoachMode } from './coach'
import { createEditorAccess } from './editor-access'
import { makeDraftStore, type AnchorRecord, type DraftStore } from './draft-store'
import { makeNote, noteId, sameNote } from './notes'
import { pickRecordingMimeType, transcribeAudio } from './dictation'
import { HighlightOverlay } from './highlight'

const SAVE_DELAY_MS = 1000

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

 const editorRef = useRef<ComponentRef<typeof MDEditor>>(null)
 const draftRef = useRef('')
 // Start from the restored genre so a sweep right after reload (which reads
 // genreRef.current) uses the persisted choice, not the agnostic default.
 const genreRef = useRef<Genre>(genre)
 const coachRef = useRef<Coach | null>(null)
 const draftStoreRef = useRef<DraftStore | null>(null)
 const saveTimerRef = useRef<number | null>(null)
 const recorderRef = useRef<MediaRecorder | null>(null)
 const chunksRef = useRef<Blob[]>([])
 const annotationsRef = useRef<AnchorRecord[]>([])
 // Sweep cancel latch: set by the Stop button, read by runSweep's
 // shouldAbort before each window so the in-flight ask finishes cleanly.
 const abortSweepRef = useRef(false)

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

 // Unmount cleanup: flush the pending save, stop any recording.
 useEffect(() => {
  return () => {
   if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
   recorderRef.current?.stop()
  }
 }, [])

 const handleContentChange = (value?: string) => {
  const text = value ?? ''
  draftRef.current = text
  setDraft(text)

  // Strip any annotation whose fragment no longer sits at its recorded
  // offsets — a rewritten passage must not keep a stale highlight alive.
  const valid = staleAnnotations(annotationsRef.current, text) as AnchorRecord[]
  if (valid.length !== annotationsRef.current.length) {
   annotationsRef.current = valid
   setSweepNotes(valid)
   void draftStoreRef.current?.saveAnnotations(valid).catch((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err))
   })
  }

  // Debounced draft save.
  if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
  saveTimerRef.current = window.setTimeout(() => {
   void draftStoreRef.current?.save(text, annotationsRef.current).catch((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err))
   })
  }, SAVE_DELAY_MS)
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
  setSweeping(true)
  setError(null)
  try {
   const plan = planSweep(fullText)
   await runSweep(plan, {
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
     // Append and persist incrementally, so a reload mid-sweep keeps
     // what arrived before it.
     annotationsRef.current = [...annotationsRef.current, record]
     setSweepNotes((prev) => [...prev, record])
     void draftStoreRef.current?.saveAnnotations(annotationsRef.current).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
     })
    },
   })
  } catch (err) {
   setError(err instanceof Error ? err.message : String(err))
  } finally {
   setSweeping(false)
   setProgress(null)
  }
 }

 // Wipe every annotation.
 const clearNotes = () => {
  setSweepNotes([])
  annotationsRef.current = []
  void draftStoreRef.current?.saveAnnotations([]).catch((err: unknown) => {
   setError(err instanceof Error ? err.message : String(err))
  })
 }

 // Remove exactly one note, matched by its (start, end, ts) identity triple,
 // from the screen and from persisted storage.
 const resolveNote = (note: AnchorRecord) => {
  const isSameNote = (a: AnchorRecord) => sameNote(a, note)
  annotationsRef.current = annotationsRef.current.filter((a) => !isSameNote(a))
  setSweepNotes((prev) => prev.filter((n) => !isSameNote(n)))
  void draftStoreRef.current?.saveAnnotations(annotationsRef.current).catch((err: unknown) => {
   setError(err instanceof Error ? err.message : String(err))
  })
 }

 const dictationLabel =
  dictationState === 'recording' ? 'Stop recording' : dictationState === 'transcribing' ? 'Transcribing…' : 'Dictate'

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
     title="Ask one coach question per window across the whole draft"
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
    <label className="genre-field">
     <span className="genre-label">Genre</span>
     <select
      className="genre-select"
      value={genre}
      onChange={(e) => {
       const next = e.target.value as Genre
       genreRef.current = next
       setGenre(next)
       try {
        window.localStorage.setItem('better-writer:genre', next)
       } catch {
        // Quota exceeded or storage disabled: fail soft — the choice just
        // doesn't survive a reload.
       }
      }}
     >
      {GENRES.map((g) => (
       <option key={g} value={g}>
        {g}
       </option>
      ))}
     </select>
    </label>
    {mode !== 'detecting' && (
     <span className={`mode-badge mode-${mode}`} title={`${mode} coach and draft store`}>
      {mode}
     </span>
    )}
   </header>

   <main className="editor-container">
    <div className="editor-wrapper">
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
       {/* The coach's mouthpiece: the latest pinned question, full text on hover. */}
       <p className="coach-question" title={sweepNotes[sweepNotes.length - 1].question}>
        {sweepNotes[sweepNotes.length - 1].question}
       </p>
       <span
        className="coach-count"
        style={{ fontSize: 11, opacity: 0.7 }}
       >
        {sweepNotes.length} pinned
       </span>
      </>
     ) : (
      <p className="coach-placeholder">Sweep the draft for craft notes.</p>
     )}
     <div className="coach-actions">{sweepControls}</div>
    </section>
   </main>
  </div>
 )
}
