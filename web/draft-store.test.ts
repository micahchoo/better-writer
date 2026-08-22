import { describe, expect, it } from 'vitest'
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

  it('server store reports no persisted annotations and no-ops on save', async () => {
    const store = new ServerDraftStore('http://unused')
    expect(await store.loadAnnotations()).toEqual([])
    await expect(store.saveAnnotations(annotations)).resolves.toBeUndefined()
    expect(await store.loadAnnotations()).toEqual([])
  })
})
