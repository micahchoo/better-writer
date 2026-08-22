import { describe, expect, it, vi } from 'vitest'
import { LocalStorageDraftStore, ServerDraftStore, type AnchorRecord } from './draft-store'

/** An in-memory Storage stand-in so tests never touch window.localStorage. */
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map: Record<string, string> = {}
  return {
    getItem: (key: string) => map[key] ?? null,
    setItem: (key: string, value: string) => void (map[key] = value),
  }
}

const annotations: AnchorRecord[] = [
  {
    start: 0,
    end: 12,
    fragment: 'Hello world.',
    question: 'How could this opening be sharper?',
    ts: 1_720_000_000_000,
  },
  {
    start: 14,
    end: 20,
    fragment: 'Second.',
    question: 'Is this paragraph pulling its weight?',
    ts: 1_720_000_001_000,
  },
]

describe('draft-store annotations', () => {
  it('round-trips annotations through localStorage', async () => {
    const store = new LocalStorageDraftStore(memoryStorage())
    await store.saveAnnotations(annotations)
    expect(await store.loadAnnotations()).toEqual(annotations)
  })

  it('starts empty when nothing was saved', async () => {
    const store = new LocalStorageDraftStore(memoryStorage())
    expect(await store.loadAnnotations()).toEqual([])
  })

  it('returns [] when the stored payload is not an array', async () => {
    const storage = memoryStorage()
    storage.setItem('better-writer:annotations', '{"start":0}')
    const store = new LocalStorageDraftStore(storage)
    expect(await store.loadAnnotations()).toEqual([])
  })

  it('returns [] when the stored payload is corrupt', async () => {
    const storage = memoryStorage()
    storage.setItem('better-writer:annotations', 'not json{')
    const store = new LocalStorageDraftStore(storage)
    expect(await store.loadAnnotations()).toEqual([])
  })

  it('keeps draft persistence independent of annotations', async () => {
    const storage = memoryStorage()
    const store = new LocalStorageDraftStore(storage)
    await store.save('Draft text.')
    await store.saveAnnotations(annotations)
    expect(await store.load()).toBe('Draft text.')
    expect(await store.loadAnnotations()).toEqual(annotations)
  })

  it('replaces the previous annotations on re-save', async () => {
    const store = new LocalStorageDraftStore(memoryStorage())
    await store.saveAnnotations(annotations)
    await store.saveAnnotations([])
    expect(await store.loadAnnotations()).toEqual([])
  })

  it('round-trips draft and annotations through the wire contract', async () => {
    const { fetchMock, getState } = fakeServer()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = new ServerDraftStore('http://local')
      await store.save('Draft text.', annotations)
      // /save carried the annotations alongside the draft.
      expect(getState()).toEqual({ draft: 'Draft text.', annotations })

      // A fresh store reads both back from /load — notes survive on the server.
      const reloaded = new ServerDraftStore('http://local')
      expect(await reloaded.load()).toBe('Draft text.')
      expect(await reloaded.loadAnnotations()).toEqual(annotations)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns [] when /load omits annotations (forward-compat)', async () => {
    const { fetchMock } = fakeServer({ draft: 'Only a draft.' })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = new ServerDraftStore('http://local')
      expect(await store.load()).toBe('Only a draft.')
      expect(await store.loadAnnotations()).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('overwrites server annotations with [] when save omits notes', async () => {
    const { fetchMock, getState } = fakeServer({ draft: 'old', annotations })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = new ServerDraftStore('http://local')
      await store.save('new draft')
      expect(getState()).toEqual({ draft: 'new draft', annotations: [] })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('saveAnnotations persists notes against the last known draft', async () => {
    const { fetchMock, getState } = fakeServer({ draft: 'Persisted.' })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = new ServerDraftStore('http://local')
      await store.load() // learn the server's draft
      await store.saveAnnotations(annotations)
      expect(getState()).toEqual({ draft: 'Persisted.', annotations })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/** An in-memory fake server backing ServerDraftStore's /load and /save. */
function fakeServer(initial: { draft?: string; annotations?: unknown[] } = {}) {
  let state: { draft?: string; annotations?: unknown[] } = { ...initial }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/load')) {
      return new Response(JSON.stringify(state), { status: 200 })
    }
    if (url.endsWith('/save')) {
      state = JSON.parse(String(init?.body)) as { draft?: string; annotations?: unknown[] }
      return new Response(null, { status: 200 })
    }
    throw new Error(`fake server: unexpected fetch ${url}`)
  })
  return { fetchMock, getState: () => state }
}
