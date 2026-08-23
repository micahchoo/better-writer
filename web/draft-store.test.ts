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

  it('persists notes that ride along with save, and keeps them on notes-less saves', async () => {
    const store = new LocalStorageDraftStore(memoryStorage())
    // Regression: the coordinator only calls save(draft, notes); ignoring the
    // notes argument here meant static-mode annotations never persisted.
    await store.save('Draft text.', annotations)
    expect(await store.loadAnnotations()).toEqual(annotations)
    await store.save('More text.')
    expect(await store.load()).toBe('More text.')
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

  it('keeps last-known anchors when a save fails', async () => {
    const { fetchMock, getState } = fakeServer({ draft: 'Persisted.' }, true)
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = new ServerDraftStore('http://local')
      await store.load() // learn the server's draft
      await expect(store.save('new draft', annotations)).rejects.toThrow('Draft save failed: 500')
      // The failed save must not have touched the server's state…
      expect(getState()).toEqual({ draft: 'Persisted.' })
      // …nor the store's anchors: saveAnnotations still rides the OLD draft.
      await store.saveAnnotations(annotations)
      expect(getState()).toEqual({ draft: 'Persisted.', annotations })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('updates anchors only after a confirmed save', async () => {
    const { fetchMock, getState } = fakeServer({ draft: 'old' })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = new ServerDraftStore('http://local')
      await store.load() // learn the server's draft
      await store.save('new draft', annotations) // 200: the server confirms
      await store.saveAnnotations([annotations[0]]) // anchored against the NEW draft
      expect(getState()).toEqual({ draft: 'new draft', annotations: [annotations[0]] })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('passes keepalive through to /save', async () => {
    const { fetchMock } = fakeServer()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = new ServerDraftStore('http://local')
      await store.save('Draft text.', undefined, { keepalive: true })
      expect(fetchMock.mock.calls.at(-1)?.[1]?.keepalive).toBe(true)

      await store.save('Draft text.')
      expect(fetchMock.mock.calls.at(-1)?.[1]?.keepalive).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to plain fetch when keepalive is rejected', async () => {
    let state: { draft?: string; annotations?: unknown[] } = {}
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/save') && init?.keepalive) {
        throw new TypeError('body too large') // Chrome's 64 KiB keepalive cap
      }
      if (url.endsWith('/save')) {
        state = JSON.parse(String(init?.body)) as { draft?: string; annotations?: unknown[] }
        return new Response(null, { status: 200 })
      }
      throw new Error(`fake server: unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = new ServerDraftStore('http://local')
      await store.save('Draft text.', annotations, { keepalive: true })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true)
      expect(fetchMock.mock.calls[1]?.[1]?.keepalive).toBeUndefined()
      expect(state).toEqual({ draft: 'Draft text.', annotations })

      // The store recorded the confirmed save — later anchors ride the new draft.
      await store.saveAnnotations([])
      expect(state).toEqual({ draft: 'Draft text.', annotations: [] })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/** An in-memory fake server backing ServerDraftStore's /load and /save.
 * When failSave is true, the first /save returns 500 and later saves succeed —
 * enough to prove the store never records a rejected save. */
function fakeServer(initial: { draft?: string; annotations?: unknown[] } = {}, failSave = false) {
  let state: { draft?: string; annotations?: unknown[] } = { ...initial }
  let firstSave = true
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/load')) {
      return new Response(JSON.stringify(state), { status: 200 })
    }
    if (url.endsWith('/save')) {
      if (failSave && firstSave) {
        firstSave = false
        return new Response('server error', { status: 500 })
      }
      state = JSON.parse(String(init?.body)) as { draft?: string; annotations?: unknown[] }
      return new Response(null, { status: 200 })
    }
    throw new Error(`fake server: unexpected fetch ${url}`)
  })
  return { fetchMock, getState: () => state }
}
