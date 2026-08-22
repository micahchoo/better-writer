import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import MDEditor from '@uiw/react-md-editor'
import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import { Mic, MicOff, Sparkles, X } from 'lucide-react'
import { GENRES, type Genre } from '../src/types'
import { markFullDraft, splitBlocks } from './text-window'
import { extractAnchor, type Anchor } from './anchor'
import { detectServerMode, makeCoach, type Coach, type CoachMode } from './coach'
import { createEditorAccess } from './editor-access'
import { makeDraftStore, type AnchorRecord, type DraftStore } from './draft-store'
import { pickRecordingMimeType, transcribeAudio } from './dictation'
import { HighlightOverlay } from './highlight'
import { planSweep, runSweep, staleAnnotations } from './coach-sweep'

const SAVE_DELAY_MS = 1000

/**
 * The block the cursor belongs to — the same rule text-window uses for the
 * cursor block (a cursor on an empty line takes the next block, past the end
 * takes the last block).
 */
function cursorBlockSpan(markdown: string, offset: number): { start: number; end: number } | null {
  const blocks = splitBlocks(markdown)
  if (blocks.length === 0) return null
  for (const block of blocks) {
    if (offset >= block.start && offset <= block.end) return { start: block.start, end: block.end }
  }
  for (const block of blocks) {
    if (block.start >= offset) return { start: block.start, end: block.end }
  }
  const last = blocks[blocks.length - 1]
  return { start: last.start, end: last.end }
}

export default function EditorApp() {
  const [mode, setMode] = useState<CoachMode | 'detecting'>('detecting')
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [draft, setDraft] = useState('')
  const [genre, setGenre] = useState<Genre>('genre-agnostic')
  const [question, setQuestion] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dictationState, setDictationState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [sweeping, setSweeping] = useState(false)
  // Sweep notes on screen: one HighlightOverlay per note, alongside the
  // single-question overlay. Each note is ALSO appended to
  // annotationsRef.current so it persists with the singles.
  const [sweepNotes, setSweepNotes] = useState<AnchorRecord[]>([])
  // SINGLE-OPEN contract: at most one note popover is open at a time, keyed
  // by the note's identity string. Two popovers can never overlap because a
  // new open supersedes the previous one.
  const [openNoteId, setOpenNoteId] = useState<string | null>(null)

  const editorRef = useRef<ComponentRef<typeof MDEditor>>(null)
  const draftRef = useRef('')
  const prevTextRef = useRef('')
  const genreRef = useRef<Genre>('genre-agnostic')
  const coachRef = useRef<Coach | null>(null)
  const draftStoreRef = useRef<DraftStore | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  // Question anchoring: the raw extractAnchor result (null in the static demo,
  // where questions cannot ground), the cursor-block fallback span, and the
  // persisted record of what is currently highlighted.
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [cursorBlock, setCursorBlock] = useState<{ start: number; end: number } | null>(null)
  // Mutable (not the readonly RefObject overload) so it can be assigned during
  // render below.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const annotationRef = useRef<AnchorRecord | null>(null)
  const annotationsRef = useRef<AnchorRecord[]>([])

  // The one editor adapter, wired to the MDEditor ref (textarea surface —
  // react-md-editor v4 has no CodeMirror view; see editor-access.ts).
  const editorAccess = useMemo(
    () => createEditorAccess({ getTextarea: () => editorRef.current?.textarea ?? null }),
    [],
  )

  // Keep the overlay's textarea ref populated. Assigned during render (not in
  // an effect) so HighlightOverlay's layout effects see the element in the
  // same commit — a parent effect would run after the child's.
  textareaRef.current = editorRef.current?.textarea ?? null

  // Light/dark from the OS, as before.
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

  // Load the saved draft once the mode (and store) is known, then restore the
  // latest question annotation whose fragment still sits at its offsets.
  useEffect(() => {
    if (mode === 'detecting' || !draftStoreRef.current) return
    let cancelled = false
    void draftStoreRef.current
      .load()
      .then((text) => {
        if (!cancelled) {
          draftRef.current = text
          prevTextRef.current = text
          setDraft(text)
        }
        return draftStoreRef.current?.loadAnnotations() ?? Promise.resolve([])
      })
      .then((annotations) => {
        if (cancelled || annotations.length === 0) return
        annotationsRef.current = annotations
        const latest = annotations[annotations.length - 1]
        // Restore only when the fragment still occupies the recorded offsets;
        // a rewritten draft must not resurrect a stale highlight.
        if (draftRef.current.slice(latest.start, latest.end) === latest.fragment) {
          setAnchor({ start: latest.start, end: latest.end, fragment: latest.fragment })
          setQuestion(latest.question)
          annotationRef.current = latest
        }
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

    // A highlight whose span no longer matches the draft can't stay pinned —
    // drop it (the question itself stays in the panel until dismissed).
    const current = annotationRef.current
    if (current && text.slice(current.start, current.end) !== current.fragment) {
      annotationRef.current = null
      setAnchor(null)
      setCursorBlock(null)
    }

    // Same rule for everything persisted: strip any annotation whose fragment
    // no longer sits at its recorded offsets (the single question above is
    // the same check, kept for its panel semantics).
    const valid = staleAnnotations(annotationsRef.current, text) as AnchorRecord[]
    if (valid.length !== annotationsRef.current.length) {
      annotationsRef.current = valid
      void draftStoreRef.current?.saveAnnotations(valid).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
    }
    const validSweep = staleAnnotations(sweepNotes, text) as AnchorRecord[]
    if (validSweep.length !== sweepNotes.length) setSweepNotes(validSweep)

    // Debounced draft save.
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      void draftStoreRef.current?.save(text).catch((err: unknown) => {
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

  const dismissQuestion = () => {
    setQuestion(null)
    const current = annotationRef.current
    setAnchor(null)
    setCursorBlock(null)
    annotationRef.current = null
    if (current) {
      // Drop the dismissed annotation from the persisted list so a reload
      // does not resurrect it (best-effort — server store is a no-op).
      annotationsRef.current = annotationsRef.current.filter((a) => a !== current)
      void draftStoreRef.current?.saveAnnotations(annotationsRef.current).catch(() => {})
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
    setSweeping(true)
    setError(null)
    try {
      const plan = planSweep(fullText)
      await runSweep(plan, {
        genre: genreRef.current,
        coach,
        draft: fullText,
        onNote: (note) => {
          const record: AnchorRecord = {
            start: note.start,
            end: note.end,
            fragment: note.fragment,
            question: note.question,
            ts: note.ts,
          }
          // Append alongside any existing single-question annotations and
          // persist incrementally, so a reload mid-sweep keeps what arrived.
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
    }
  }

  // Wipe every annotation — the single-question one and all sweep notes.
  const clearNotes = () => {
    annotationRef.current = null
    setAnchor(null)
    setCursorBlock(null)
    setQuestion(null)
    setSweepNotes([])
    annotationsRef.current = []
    void draftStoreRef.current?.saveAnnotations([]).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  // Remove exactly one note, matched by its (start, end, ts) identity triple,
  // from the screen and from persisted storage.
  const resolveNote = (note: AnchorRecord) => {
    const identity = (a: AnchorRecord) => a.start === note.start && a.end === note.end && a.ts === note.ts
    annotationsRef.current = annotationsRef.current.filter((a) => !identity(a))
    setSweepNotes((prev) => prev.filter((n) => !identity(n)))
    void draftStoreRef.current?.saveAnnotations(annotationsRef.current).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  const dictationLabel =
    dictationState === 'recording' ? 'Stop recording' : dictationState === 'transcribing' ? 'Transcribing…' : 'Dictate'

  // Sweep + clear live next to Ask now whenever the local coach is active.
  const sweepControls = mode === 'local' && (
    <>
      <button
        className="coach-sweep"
        onClick={() => void sweepDraft()}
        disabled={sweeping}
        title="Ask one coach question per window across the whole draft"
      >
        {sweeping ? 'Sweeping…' : 'Sweep draft'}
      </button>
      <button
        className="coach-clear"
        onClick={clearNotes}
        disabled={sweepNotes.length === 0 && question === null}
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
          {(anchor || cursorBlock) && question && (
            <HighlightOverlay
              draft={draft}
              anchor={anchor}
              question={question}
              cursorBlock={cursorBlock}
              textareaRef={textareaRef}
              onResolve={dismissQuestion}
              // A fresh Ask now answer supersedes any open sweep-note
              // popover: the single overlay claims the open slot.
              noteId="single"
              activeId={openNoteId}
              onOpenChange={setOpenNoteId}
            />
          )}
          {sweepNotes.map((note) => {
            const noteId = `${note.start}:${note.end}:${note.ts}`
            return (
              <HighlightOverlay
                key={noteId}
                draft={draft}
                anchor={{ start: note.start, end: note.end }}
                question={note.question}
                cursorBlock={null}
                textareaRef={textareaRef}
                noteId={noteId}
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
          {question ? (
            <>
              <p className="coach-question">{question}</p>
              <div className="coach-actions">
                {sweepControls}
                <button
                  className="coach-dismiss"
                  onClick={dismissQuestion}
                  aria-label="Dismiss question"
                  title="Dismiss"
                >
                  <X size={14} />
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="coach-placeholder">
                <Sparkles size={14} className="coach-sparkle" />
                One craft question about what you&apos;re writing — ask when you want a fresh eye.
              </p>
              <div className="coach-actions">
                {sweepControls}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  )
}
