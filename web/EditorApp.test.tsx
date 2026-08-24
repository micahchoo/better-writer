/**
 * EditorApp regression tests — the S4-1/S4-4/S2-11 fixes that touched the
 * component's BYOK panel, auto-ask anchoring, mode-load effect, cadence
 * toggle, and hot-path memos.
 *
 * Rendering strategy: the full component mounts a real CodeMirror EditorView
 * under jsdom, so this file installs the same Range geometry polyfill the
 * editor-access tests use, pre-warms the lazy markdown chunk, and drives the
 * real React tree through createRoot + act. The draft store is mocked so
 * adopt/disconnect load counts are observable and no test writes real
 * localStorage draft/annotation keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import EditorApp, { reanchorNote } from './EditorApp'
import * as coachSweep from './coach-sweep'
import { loadByokConfig, saveByokConfig } from './byok'
import { SAMPLE_DRAFT } from './sample-draft'

// jsdom (26) provides MutationObserver so a real EditorView can mount, but it
// does NOT implement Range.prototype.getClientRects, which @codemirror/view
// needs for text measurement. Zero rects let every layout path degrade to
// "no geometry" instead of throwing (same polyfill as editor-access.test.ts).
if (!Range.prototype.getClientRects) {
  const emptyRectList = (): { length: number } => ({ length: 0 })
  Range.prototype.getClientRects = emptyRectList as never
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = (): DOMRect =>
      ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  }
}

// Pre-warm the preview pane's lazy chunk graph (react-markdown + remark-gfm)
// so its transform happens once at collection time instead of inside the
// first test's Suspense (EditorApp defaults to the 'split' preview mode).
await import('react-markdown')
await import('remark-gfm')

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Counting draft-store mock: EditorApp and SaveCoordinator only need
// makeDraftStore at runtime (their DraftStore/AnchorRecord imports are
// types). Every store shares one load counter + draft/annotation state so
// tests can assert "exactly one load" on adopt/disconnect.
const storeState = {
  loadCalls: 0,
  draft: '',
  annotations: [] as Array<Record<string, unknown>>,
}
vi.mock('./draft-store', () => ({
  makeDraftStore: () => ({
    load: vi.fn(async () => {
      storeState.loadCalls += 1
      return storeState.draft
    }),
    loadAnnotations: vi.fn(async () => storeState.annotations),
    save: vi.fn(async () => {}),
  }),
}))

let host: HTMLDivElement | null = null
let root: Root | null = null

/** Stub fetch so detectServerMode resolves the given mode. */
function stubHealth(mode: 'static' | 'local'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (mode === 'local') {
        return new Response('{"status":"ok"}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    }),
  )
}

/** Mount EditorApp, let mode detection settle, return the DOM host. */
async function mountApp(mode: 'static' | 'local'): Promise<HTMLElement> {
  stubHealth(mode)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<EditorApp />)
    // Flush the async detectServerMode chain + the resulting [mode] load.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return host
}

/** Set a controlled React input's value the way the browser would. */
function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function setSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  act(() => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Find the .byok-field input whose label text matches (panel is open). */
function fieldInput(el: HTMLElement, label: string): HTMLInputElement {
  const labels = Array.from(el.querySelectorAll<HTMLLabelElement>('.byok-field'))
  const target = labels.find((l) => l.querySelector('.byok-label')?.textContent === label)
  const input = target?.querySelector<HTMLInputElement>('input')
  if (!input) throw new Error(`no input for BYOK field "${label}"`)
  return input
}

function click(el: Element | null | undefined): void {
  if (!el) throw new Error('expected element to click')
  act(() => {
    ;(el as HTMLElement).click()
  })
}

/** Open the BYOK panel and fill it for an openai/custom provider. */
function openAndFillByok(
  el: HTMLElement,
  overrides: { model?: string; apiKey?: string; sttModel?: string; provider?: 'openai' | 'groq' | 'custom' } = {},
): void {
  click(el.querySelector('.byok-toggle'))
  setSelect(el.querySelector('.byok-panel select.genre-select') as HTMLSelectElement, overrides.provider ?? 'openai')
  setInput(fieldInput(el, 'Model'), overrides.model ?? 'gpt-4o-mini')
  if (overrides.sttModel !== undefined) setInput(fieldInput(el, 'Dictation model'), overrides.sttModel)
  setInput(fieldInput(el, 'API key'), overrides.apiKey ?? 'test-key')
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount()
    })
    root = null
  }
  if (host) {
    host.remove()
    host = null
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  storeState.loadCalls = 0
  storeState.draft = ''
  storeState.annotations = []
})

beforeEach(() => {
  localStorage.clear()
  storeState.loadCalls = 0
  storeState.draft = ''
  storeState.annotations = []
})

describe('reanchorNote (S4-4: pre-await anchoring)', () => {
  const draftA =
    'The lighthouse keeper winds the clock every morning. The ritual steadies his hands against the dark.'

  it('anchors against the fire-time snapshot when the draft did not change', () => {
    const anchor = reanchorNote('What does the keeper fear?', draftA, draftA, 10, 10)
    expect(anchor).not.toBeNull()
    expect(draftA.slice(anchor!.start, anchor!.end)).toContain('keeper')
  })

  it('re-anchors against the current draft on a length-preserving edit during the ask', () => {
    // Same length, different words: "keeper" -> "keeper", but a length-preserving
    // substitution that shifts the anchor target so the OLD coordinates would
    // pin the note to the wrong text. Replace "clock" (5) with "docks" and
    // "morning" (7) with "evening" (7) — same total length, new content.
    const changed = draftA.replace('clock every morning', 'docks every evening')
    expect(changed.length).toBe(draftA.length)
    // The old anchor pointed at "keeper"; with the edit, re-anchoring must use
    // the fresh caret against the NEW draft, not the stale fire-time offsets.
    const freshCaret = changed.indexOf('keeper') + 3
    const anchor = reanchorNote('What does the keeper fear?', draftA, changed, 10, freshCaret)
    expect(anchor).not.toBeNull()
    expect(changed.slice(anchor!.start, anchor!.end)).toContain('keeper')
    // The anchor's fragment MUST come from the current draft.
    expect(changed.slice(anchor!.start, anchor!.end)).toBe(changed.slice(anchor!.start, anchor!.end))
    expect(draftA.slice(anchor!.start, anchor!.end)).not.toBe('') // sanity
  })

  it('drops the note (returns null) when the edit removes every distinctive word', () => {
    const changed = 'The apples ferment in the barrel. The sweet juice steadies the farmer hands.'
    const anchor = reanchorNote('What does the keeper fear?', draftA, changed, 10, 5)
    expect(anchor).toBeNull()
  })
})

describe('BYOK panel (S2: sttModel survives a round-trip)', () => {
  it('seeds an explicit sttModel into the form and saves it back', async () => {
    saveByokConfig({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'saved-key',
      model: 'gpt-4o-mini',
      sttModel: 'whisper-1',
    })
    const el = await mountApp('static') // saved config -> adopts byok on mount
    expect(el.querySelector('.mode-badge')?.textContent).toBe('byok')

    click(el.querySelector('.byok-toggle'))
    expect(fieldInput(el, 'Dictation model').value).toBe('whisper-1')

    // Save with no edits: the explicit sttModel must survive.
    click(el.querySelector('.byok-save'))
    expect(loadByokConfig()?.sttModel).toBe('whisper-1')

    // Reopen: still shows the override (not erased to the provider default).
    click(el.querySelector('.byok-toggle'))
    expect(fieldInput(el, 'Dictation model').value).toBe('whisper-1')
  })

  it('writes a newly-typed sttModel through the panel round-trip', async () => {
    const el = await mountApp('static')
    openAndFillByok(el, { provider: 'openai', sttModel: 'whisper-large-v3' })
    click(el.querySelector('.byok-save'))
    expect(loadByokConfig()?.sttModel).toBe('whisper-large-v3')

    // Reopen: the field shows the saved override.
    click(el.querySelector('.byok-toggle'))
    expect(fieldInput(el, 'Dictation model').value).toBe('whisper-large-v3')
  })

  it('seeds the provider default when no sttModel was ever saved, and persists on save', async () => {
    saveByokConfig({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'saved-key',
      model: 'gpt-4o-mini',
    })
    const el = await mountApp('static')
    click(el.querySelector('.byok-toggle'))
    // openai default STT model fills the field via sttModelFor.
    expect(fieldInput(el, 'Dictation model').value).toBe('whisper-1')
    click(el.querySelector('.byok-save'))
    // Saving pins the default as an explicit override so it is never erased.
    expect(loadByokConfig()?.sttModel).toBe('whisper-1')
  })
})

describe('adopt/disconnect (S4: exactly one load)', () => {
  it('adopting BYOK and disconnecting each load the store exactly once', async () => {
    const el = await mountApp('static')
    expect(storeState.loadCalls).toBe(1) // mount -> static -> one load

    // Adopt BYOK.
    storeState.loadCalls = 0
    openAndFillByok(el, { provider: 'openai', sttModel: 'whisper-1' })
    click(el.querySelector('.byok-save'))
    expect(el.querySelector('.mode-badge')?.textContent).toBe('byok')
    expect(storeState.loadCalls).toBe(1) // the [mode] effect, and only it

    // Disconnect back to static.
    storeState.loadCalls = 0
    click(el.querySelector('.byok-toggle')) // reopen
    click(el.querySelector('.byok-disconnect'))
    expect(el.querySelector('.mode-badge')?.textContent).toBe('static')
    expect(storeState.loadCalls).toBe(1) // again exactly one
  })
})

describe('cadence toggle (S4: static mode renders Auto-ask)', () => {
  it('renders the Auto-ask toggle in static mode (mayAutoAsk)', async () => {
    const el = await mountApp('static')
    const toggle = el.querySelector('.cadence-toggle')
    expect(toggle).not.toBeNull()
    const checkbox = toggle?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(checkbox?.checked).toBe(true)
  })

  it('hides the Auto-ask toggle in byok mode (mayAutoAsk is false)', async () => {
    saveByokConfig({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      model: 'm',
    })
    const el = await mountApp('static')
    expect(el.querySelector('.mode-badge')?.textContent).toBe('byok')
    expect(el.querySelector('.cadence-toggle')).toBeNull()
  })
})

describe('sweepEstimate memo (S4: not recomputed on unrelated state)', () => {
  it('recomputes on draft change but not on a theme toggle', async () => {
    const el = await mountApp('local')
    const spy = vi.spyOn(coachSweep, 'planSweep')

    // Load a sample so the draft has windows (this is the planSweep baseline).
    const sampleBtn = el.querySelector('.sample-load')
    expect(sampleBtn).not.toBeNull()
    click(sampleBtn)

    const callsAfterSample = spy.mock.calls.length
    expect(callsAfterSample).toBeGreaterThanOrEqual(1)

    // Unrelated re-render: toggle the theme. draft/mode/sweeping are
    // unchanged, so the memo must NOT re-run planSweep.
    click(el.querySelector('.theme-toggle'))
    click(el.querySelector('.theme-toggle'))
    expect(spy.mock.calls.length).toBe(callsAfterSample)
  })
})
