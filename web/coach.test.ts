import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientSeed, CoachInput, Genre } from '../src/core/types'
import { detectServerMode, isModelBacked, loadSeeds, makeCoach, mayAutoAsk, seedMatchesGenre, StaticCoach } from './coach'

const fiction: ClientSeed = { id: 'f1', question: 'Fiction question?', genre: ['fiction'] }
const agnostic: ClientSeed = { id: 'a1', question: 'Any genre question?', genre: ['genre-agnostic'] }
const memoir: ClientSeed = { id: 'm1', question: 'Memoir question?', genre: ['memoir'] }
const seeds = [fiction, agnostic, memoir]
const input = (genre: Genre = 'fiction'): CoachInput => ({ textWindow: 'copper kettle', genre, cursorOffset: 0 })
const grounded = { kind: 'question', question: 'What do you want the copper kettle to suggest?', source: 'reshaped', evidence: { quote: 'copper kettle', start: 0, end: 13 } }

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
      const question = await coach.ask(input())
      expect(question.kind).toBe('question')
      if (question.kind === 'question') expect(['Fiction question?', 'Any genre question?']).toContain(question.question)
    }
  })

  it('returns the question verbatim — no id or provenance', async () => {
    const coach = new StaticCoach([fiction])
    expect(await coach.ask(input())).toEqual({ kind: 'question', question: 'Fiction question?', source: 'seed' })
  })

  it('picks uniformly across the filtered pool (random index maps to a pool member)', async () => {
    const originalRandom = Math.random
    try {
      const coach = new StaticCoach([fiction, agnostic])
      Math.random = () => 0
      expect(await coach.ask(input())).toEqual({ kind: 'question', question: 'Fiction question?', source: 'seed' })
      Math.random = () => 0.99
      expect(await coach.ask(input())).toEqual({ kind: 'question', question: 'Any genre question?', source: 'seed' })
    } finally {
      Math.random = originalRandom
    }
  })

  it('throws a descriptive error when no seed matches the genre', async () => {
    const coach = new StaticCoach([fiction])
    await expect(coach.ask(input('poetry'))).rejects.toThrow(/poetry/)
  })
})

describe('mayAutoAsk', () => {
  it('never fires unprompted in byok — a timer must not spend the writer\'s tokens', () => {
    expect(mayAutoAsk('byok')).toBe(false)
  })

  it('never fires before the mode is known', () => {
    expect(mayAutoAsk('detecting')).toBe(false)
  })

  it('fires in the free modes', () => {
    // Static MUST stay true: it has no Sweep control, so the cadence timer is
    // its only path to a question and the hosted demo goes inert without it.
    expect(mayAutoAsk('static')).toBe(true)
    expect(mayAutoAsk('local')).toBe(true)
  })

  it('is narrower than isModelBacked — the two must never be confused', () => {
    // The bug this guards: gating the timer on isModelBacked (or on nothing,
    // trusting the hidden Auto-ask checkbox) lets byok fire unprompted.
    expect(isModelBacked('byok')).toBe(true)
    expect(mayAutoAsk('byok')).toBe(false)
  })
})

describe('makeCoach', () => {
  it('"static" coaches against the real bundled seed bank', async () => {
    const coach = makeCoach('static')
    const question = await coach.ask(input('memoir'))
    expect(question.kind).toBe('question')
    if (question.kind === 'question') expect(question.question.length).toBeGreaterThan(10)
  })

  it('"local" POSTs the text window + genre to /ask and returns response.question', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(grounded), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const coach = makeCoach('local')
    const question = await coach.ask({ ...input('essay'), cursorOffset: 42 })

    expect(question).toEqual(grounded)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/ask')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      ...input('essay'), cursorOffset: 42,
    })
  })

  it('"local" reports unavailability when /ask fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })),
    )
    const coach = makeCoach('local')
    expect(await coach.ask(input())).toEqual({ kind: 'unavailable', retryable: true })
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


describe('loadSeeds (S2-11: lazy seed-bank split)', () => {
  it('caches the loaded bank so repeated draws trigger at most one async load', async () => {
    // The module-level loader returns the SAME promise for every caller, so a
    // second draw (StaticCoach or ByokCoach) never triggers a second fetch.
    const first = loadSeeds()
    const second = loadSeeds()
    expect(second).toBe(first)
    const seeds = await first
    expect(seeds.length).toBeGreaterThan(1000)
  })
})


describe('LocalCoach request isolation', () => {
  it('preserves each result when concurrent requests finish out of order', async () => {
    let resolveFirst!: (value: Response) => void
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'skip', reason: 'no-fit' })))
    vi.stubGlobal('fetch', fetchMock)
    const coach = makeCoach('local')
    const first = coach.ask(input())
    const second = await coach.ask(input())
    resolveFirst(new Response(JSON.stringify(grounded)))
    expect(await first).toEqual(grounded)
    expect(second).toEqual({ kind: 'skip', reason: 'no-fit' })
  })

  it('cancels the transport and propagates the caller reason', async () => {
    let transportSignal!: AbortSignal
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      transportSignal = init.signal!
      transportSignal.addEventListener('abort', () => reject(new Error('transport aborted')))
    })))
    const controller = new AbortController()
    const pending = makeCoach('local').ask(input(), controller.signal)
    const reason = new Error('session replaced')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(transportSignal.aborted).toBe(true)
  })

  it('rejects corrupt evidence at the response boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...grounded, evidence: { quote: 'silver kettle', start: 0, end: 13 } }))))
    expect(await makeCoach('local').ask(input())).toEqual({ kind: 'unavailable', retryable: false })
  })
})
