import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import MDEditor from '@uiw/react-md-editor'
import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'
import { Mic, MicOff, Sparkles, X } from 'lucide-react'
import { GENRES, type Genre } from '../src/types'
import { textWindow } from './text-window'
import { AskTrigger } from './trigger'
import { detectServerMode, makeCoach, type Coach, type CoachMode } from './coach'
import { createEditorAccess } from './editor-access'
import { makeDraftStore, type DraftStore } from './draft-store'
import { pickRecordingMimeType, transcribeAudio } from './dictation'

const SAVE_DELAY_MS = 1000

function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

export default function EditorApp() {
  const [mode, setMode] = useState<CoachMode | 'detecting'>('detecting')
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [draft, setDraft] = useState('')
  const [genre, setGenre] = useState<Genre>('genre-agnostic')
  const [question, setQuestion] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dictationState, setDictationState] = useState<'idle' | 'recording' | 'transcribing'>('idle')

  const editorRef = useRef<ComponentRef<typeof MDEditor>>(null)
  const draftRef = useRef('')
  const prevTextRef = useRef('')
  const genreRef = useRef<Genre>('genre-agnostic')
  const coachRef = useRef<Coach | null>(null)
  const draftStoreRef = useRef<DraftStore | null>(null)
  const triggerRef = useRef(new AskTrigger())
  const saveTimerRef = useRef<number | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  // The one editor adapter, wired to the MDEditor ref (textarea surface —
  // react-md-editor v4 has no CodeMirror view; see editor-access.ts).
  const editorAccess = useMemo(
    () => createEditorAccess({ getTextarea: () => editorRef.current?.textarea ?? null }),
    [],
  )

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

  // Load the saved draft once the mode (and store) is known.
  useEffect(() => {
    if (mode === 'detecting' || !draftStoreRef.current) return
    let cancelled = false
    void draftStoreRef.current
      .load()
      .then((text) => {
        if (cancelled) return
        draftRef.current = text
        prevTextRef.current = text
        setDraft(text)
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

  const askNow = async () => {
    const coach = coachRef.current
    if (!coach || asking) return
    setAsking(true)
    setError(null)
    try {
      const cursor = editorAccess.readCursor()
      const fullText = cursor?.text ?? draftRef.current
      const offset = cursor?.offset ?? fullText.length
      const windowText = textWindow(fullText, offset)
      if (!windowText) {
        setError('There is no text at the cursor yet — write something first.')
        return
      }
      const next = await coach.ask(windowText, genreRef.current)
      setQuestion(next) // one question, replace-not-stack
      triggerRef.current.manualAsk()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAsking(false)
    }
  }

  const handleContentChange = (value?: string) => {
    const text = value ?? ''
    draftRef.current = text
    setDraft(text)

    // Word-count trigger: fire when 30 net-new words have accumulated AND
    // the idle gate (2s since the last question) is open.
    const delta = countWords(text) - countWords(prevTextRef.current)
    prevTextRef.current = text
    if (
      delta > 0 &&
      triggerRef.current.shouldFire(Date.now()) &&
      triggerRef.current.onWordsAdded(delta)
    ) {
      void askNow()
    }

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

  const dictationLabel =
    dictationState === 'recording' ? 'Stop recording' : dictationState === 'transcribing' ? 'Transcribing…' : 'Dictate'

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
                <button className="coach-ask" onClick={() => void askNow()} disabled={asking}>
                  {asking ? 'Asking…' : 'Another'}
                </button>
                <button
                  className="coach-dismiss"
                  onClick={() => setQuestion(null)}
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
                <button className="coach-ask" onClick={() => void askNow()} disabled={asking}>
                  {asking ? 'Asking…' : 'Ask now'}
                </button>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  )
}
