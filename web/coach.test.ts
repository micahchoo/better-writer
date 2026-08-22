import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientSeed, Genre } from '../src/types'
import { detectServerMode, makeCoach, seedMatchesGenre, StaticCoach } from './coach'

const fiction: ClientSeed = { id: 'f1', question: 'Fiction question?', genre: ['fiction'] }
const agnostic: ClientSeed = { id: 'a1', question: 'Any genre question?', genre: ['genre-agnostic'] }
const memoir: ClientSeed = { id: 'm1', question: 'Memoir question?', genre: ['memoir'] }
const seeds = [fiction, agnostic, memoir]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('seedMatchesGenre', () => {
  it('matches seeds tagged with the requested genre', () => {
    expect(seedMatchesGenre(fiction, 'fiction')).toBe(true)
    expect(seedMatchesGenre(memoir, 'fiction')).toBe(false)
  })

  it('genre-agnostic is a wildcard that matches any genre filter', () => {
    const allGenres: Genre[] = ['fiction', 'creative-nonfiction', 'memoir', 'essay', 'poetry', 'genre-agnostic']
    for (const genre of allGenres) {
      expect(seedMatchesGenre(agnostic, genre)).toBe(true)
    }
  })

  it('does not let a specific genre leak into a different filter', () => {
    expect(seedMatchesGenre(fiction, 'poetry')).toBe(false)
  })
})

describe('StaticCoach', () => {
  it('only returns questions from seeds matching the genre filter', async () => {
    const coach = new StaticCoach(seeds)
    for (let i = 0; i < 50; i++) {
      const question = await coach.ask('ignored', 'fiction', 0)
      expect(['Fiction question?', 'Any genre question?']).toContain(question)
    }
  })

  it('returns the question verbatim — no id or provenance', async () => {
    const coach = new StaticCoach([fiction])
    expect(await coach.ask('ignored', 'fiction', 0)).toBe('Fiction question?')
  })

  it('picks uniformly across the filtered pool (random index maps to a pool member)', async () => {
    const originalRandom = Math.random
    try {
      const coach = new StaticCoach([fiction, agnostic])
      Math.random = () => 0
      expect(await coach.ask('ignored', 'fiction', 0)).toBe('Fiction question?')
      Math.random = () => 0.99
      expect(await coach.ask('ignored', 'fiction', 0)).toBe('Any genre question?')
    } finally {
      Math.random = originalRandom
    }
  })

  it('throws a descriptive error when no seed matches the genre', async () => {
    const coach = new StaticCoach([fiction])
    await expect(coach.ask('ignored', 'poetry', 0)).rejects.toThrow(/poetry/)
  })
})

describe('makeCoach', () => {
  it('"static" coaches against the real bundled seed bank', async () => {
    const coach = makeCoach('static')
    const question = await coach.ask('ignored', 'memoir', 0)
    expect(typeof question).toBe('string')
    expect(question.length).toBeGreaterThan(10)
  })

  it('"local" POSTs the text window + genre to /ask and returns response.question', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ question: 'Server question?' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const coach = makeCoach('local')
    const question = await coach.ask('window text', 'essay', 42)

    expect(question).toBe('Server question?')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/ask')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      text_window: 'window text',
      genre: 'essay',
      cursor_offset: 42,
    })
  })

  it('"local" throws when /ask fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })),
    )
    const coach = makeCoach('local')
    await expect(coach.ask('window text', 'fiction', 0)).rejects.toThrow(/500/)
  })
})

describe('detectServerMode', () => {
  it('resolves local when /health answers 200 JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"status":"ok"}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    )
    expect(await detectServerMode()).toBe('local')
  })

  it('resolves static on a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404, headers: { 'Content-Type': 'text/html' } })),
    )
    expect(await detectServerMode()).toBe('static')
  })

  it('resolves static when a 200 is not JSON (SPA fallback page)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
    )
    expect(await detectServerMode()).toBe('static')
  })

  it('resolves static when the probe fails (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    expect(await detectServerMode()).toBe('static')
  })
})
