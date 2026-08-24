import { describe, expect, it } from 'vitest'
import { implVerbs, IMPL_VERBS, measureWindow, type WindowStats } from './window-stats'

/** A sentence of exactly `n` neutral words, ending in a period. */
function sentenceOf(n: number): string {
  return Array.from({ length: n }, () => 'word').join(' ') + '.'
}

/** A single-sentence passage of `n` words, the first being `head`. */
function passage(head: string, n: number): string {
  return [head, ...Array.from({ length: n - 1 }, () => 'filler')].join(' ')
}

describe('dialogue axis', () => {
  it('fires when double-quote char share is at least 0.25', () => {
    const raw = '"This entire passage sits inside dialogue quotes and runs on at length."'
    const s = measureWindow(raw)
    expect(s.values.dialogueDensity).toBeGreaterThanOrEqual(0.25)
    expect(s.axes.has('dialogue')).toBe(true)
  })

  it('does not fire on prose with only a short quote', () => {
    const raw = 'A brief prose passage with a short "bit" of quotation inside it.'
    const s = measureWindow(raw)
    expect(s.values.dialogueDensity).toBeLessThan(0.25)
    expect(s.axes.has('dialogue')).toBe(false)
  })

  it('measures density as inside-chars over total chars', () => {
    // '"ab"' → 2 quoted chars of 4 total.
    expect(measureWindow('"ab"').values.dialogueDensity).toBeCloseTo(0.5)
  })
})

describe('curly quotes and apostrophes', () => {
  it('counts curly double quotes as dialogue', () => {
    const raw = '“This whole thing is dialogue in curly quotes right here.”'
    const s = measureWindow(raw)
    expect(s.values.dialogueDensity).toBeGreaterThanOrEqual(0.25)
    expect(s.axes.has('dialogue')).toBe(true)
  })

  it('does not open a quote span on an apostrophe', () => {
    const raw = "It's a dog's life"
    const s = measureWindow(raw)
    expect(s.values.dialogueDensity).toBe(0)
    expect(s.axes.has('dialogue')).toBe(false)
  })

  it('ignores apostrophes while still counting a real quote', () => {
    const raw = `It's not "here" today`
    // Inside chars = "here" = 4; total = the whole string length.
    const s = measureWindow(raw)
    expect(s.values.dialogueDensity).toBeCloseTo(4 / raw.length)
    expect(s.axes.has('dialogue')).toBe(false) // 4 chars well under 25%
  })
})

describe('rhythm axis', () => {
  it('fires when mean is above 30 and sigma is below 12', () => {
    const raw = [sentenceOf(33), sentenceOf(33), sentenceOf(33)].join(' ')
    const s = measureWindow(raw)
    expect(s.values.sentenceMean).toBe(33)
    expect(s.values.sentenceSigma).toBeCloseTo(0)
    expect(s.axes.has('rhythm')).toBe(true)
  })

  it('does not fire when the mean is at or below 30', () => {
    const raw = [sentenceOf(10), sentenceOf(10), sentenceOf(10)].join(' ')
    expect(measureWindow(raw).axes.has('rhythm')).toBe(false)
  })

  it('does not fire when the spread is wide even if the mean is high', () => {
    const raw = [sentenceOf(20), sentenceOf(20), sentenceOf(60)].join(' ')
    const s = measureWindow(raw)
    expect(s.values.sentenceMean).toBeGreaterThan(30)
    expect(s.values.sentenceSigma).toBeGreaterThanOrEqual(12)
    expect(s.axes.has('rhythm')).toBe(false)
  })

  it('uses population stddev and counts long sentences', () => {
    const raw = [sentenceOf(1), sentenceOf(3)].join(' ')
    const s = measureWindow(raw)
    expect(s.values.sentenceMean).toBeCloseTo(2)
    expect(s.values.sentenceSigma).toBeCloseTo(1) // ((1-2)^2+(3-2)^2)/2 = 1
    expect(s.values.longSentences).toBe(0)
    // 42 words is > 40.
    expect(measureWindow(sentenceOf(42)).values.longSentences).toBe(1)
  })
})

describe('hedge axis', () => {
  it('fires when the adverb/hedge rate exceeds 4 per 100 words', () => {
    const raw = passage('very', 20) // 1 hedge / 20 words = 5%
    const s = measureWindow(raw)
    expect(s.values.adverbRate).toBeCloseTo(5)
    expect(s.axes.has('hedge')).toBe(true)
  })

  it('does not fire at or below 4 per 100 words', () => {
    const raw = passage('very', 30) // 1 / 30 = 3.33%
    const s = measureWindow(raw)
    expect(s.values.adverbRate).toBeLessThan(4)
    expect(s.axes.has('hedge')).toBe(false)
  })
})

describe('filter-word axis', () => {
  it('fires when a filter verb rate exceeds 2 per 100 words', () => {
    const raw = passage('felt', 40) // 1 / 40 = 2.5%
    const s = measureWindow(raw)
    expect(s.values.filterRate).toBeCloseTo(2.5)
    expect(s.axes.has('filter-word')).toBe(true)
  })

  it('does not fire at or below 2 per 100 words', () => {
    const raw = passage('felt', 60) // 1 / 60 = 1.67%
    const s = measureWindow(raw)
    expect(s.values.filterRate).toBeLessThan(2)
    expect(s.axes.has('filter-word')).toBe(false)
  })

  it('matches only the six listed filter verbs', () => {
    const raw = 'She felt it, then watched and wondered, but merely looked on.'
    const s = measureWindow(raw)
    // felt, watched, wondered = 3 of 11 words; looked is not in the list.
    expect(s.values.filterRate).toBeCloseTo((3 / 11) * 100)
  })
})

describe('nominal axis', () => {
  it('fires when nominalizations plus passives exceed 5 per 100 words', () => {
    const raw = 'The decision was created by the commitment and the transformation of our nation.'
    const s = measureWindow(raw)
    // suffix words: decision, commitment, transformation, nation (4) + passive sentence (1)
    expect(s.values.nominalRate).toBeGreaterThan(5)
    expect(s.axes.has('nominal')).toBe(true)
  })

  it('does not fire on plain prose with no nominalizations', () => {
    const raw = 'The dog ran across the bright green field today.'
    const s = measureWindow(raw)
    expect(s.values.nominalRate).toBe(0)
    expect(s.axes.has('nominal')).toBe(false)
  })

  it('excludes function words from the suffix count', () => {
    // "hence" ends in -ence but is not a content word.
    const raw = 'Hence the matter, hence the trouble.'
    expect(measureWindow(raw).values.nominalRate).toBe(0)
  })
})

describe('opening/closing position axes', () => {
  const CLEAN = 'The dog ran across the field today.'

  it('fires opening-position only on the first block of a 3+ block section', () => {
    expect(
      measureWindow(CLEAN, { sectionBlockCount: 3, blockIndexInSection: 0 }).axes.has('opening-position'),
    ).toBe(true)
    expect(
      measureWindow(CLEAN, { sectionBlockCount: 3, blockIndexInSection: 1 }).axes.has('opening-position'),
    ).toBe(false)
    // Needs at least three blocks.
    expect(
      measureWindow(CLEAN, { sectionBlockCount: 2, blockIndexInSection: 0 }).axes.has('opening-position'),
    ).toBe(false)
  })

  it('fires closing-position only on the last block of a 3+ block section', () => {
    expect(
      measureWindow(CLEAN, { sectionBlockCount: 3, blockIndexInSection: 2 }).axes.has('closing-position'),
    ).toBe(true)
    expect(
      measureWindow(CLEAN, { sectionBlockCount: 3, blockIndexInSection: 1 }).axes.has('closing-position'),
    ).toBe(false)
    expect(
      measureWindow(CLEAN, { sectionBlockCount: 2, blockIndexInSection: 1 }).axes.has('closing-position'),
    ).toBe(false)
  })

  it('requires positionContext to fire position axes', () => {
    expect(measureWindow(CLEAN).axes.has('opening-position')).toBe(false)
    expect(measureWindow(CLEAN).axes.has('closing-position')).toBe(false)
  })
})

describe('markdown stripping', () => {
  it('drops link URLs so they cannot inflate word counts', () => {
    const linked = 'Here is a [link](https://example.com/very/long/url/path) in my sentence.'
    const plain = 'Here is a link in my sentence.'
    const sLinked = measureWindow(linked)
    const sPlain = measureWindow(plain)
    expect(sLinked.values).toEqual(sPlain.values)
    expect(sLinked.values.sentenceMean).toBe(7)
  })

  it('removes images entirely, including alt text', () => {
    const withImage = 'Look at the ![diagram](img.png) please.'
    expect(measureWindow(withImage).values.sentenceMean).toBe(
      measureWindow('Look at the please.').values.sentenceMean,
    )
    expect(measureWindow(withImage).values.sentenceMean).toBe(4)
  })

  it('excludes heading-line text from sentence stats', () => {
    const raw = '# A Heading Line\nBody prose here.'
    expect(measureWindow(raw).values.sentenceMean).toBe(3)
  })

  it('removes code spans from the prose', () => {
    const raw = 'Run `npm install` now.'
    expect(measureWindow(raw).values.sentenceMean).toBe(2)
  })
})

/** A WindowStats with only the given axes set; values are irrelevant to implVerbs. */
function statsWithAxes(axes: string[]): WindowStats {
  return {
    axes: new Set(axes),
    values: {
      dialogueDensity: 0,
      sentenceMean: 0,
      sentenceSigma: 0,
      longSentences: 0,
      adverbRate: 0,
      filterRate: 0,
      nominalRate: 0,
    },
  }
}

describe('IMPL_VERBS table', () => {
  it('maps each of the seven axes to its exact verb buckets', () => {
    expect(IMPL_VERBS).toEqual({
      dialogue: ['concept-form', 'elaborate'],
      rhythm: ['cut', 'rewrite'],
      hedge: ['cut', 'rephrase'],
      'filter-word': ['rewrite', 'elaborate'],
      nominal: ['rephrase', 'rewrite'],
      'opening-position': ['concept-form', 'elaborate'],
      'closing-position': ['transition', 'elaborate'],
    })
  })
})

describe('implVerbs', () => {
  it('returns [] when no axis fires', () => {
    expect(implVerbs(statsWithAxes([]))).toEqual([])
  })

  it('returns a single axis bucket in verb order', () => {
    expect(implVerbs(statsWithAxes(['rhythm']))).toEqual(['cut', 'rewrite'])
    expect(implVerbs(statsWithAxes(['closing-position']))).toEqual(['transition', 'elaborate'])
  })

  it('unions fired axes in first-seen order, deduping shared verbs', () => {
    // rhythm (cut, rewrite) then hedge (cut, rephrase): 'cut' is shared.
    expect(implVerbs(statsWithAxes(['rhythm', 'hedge']))).toEqual(['cut', 'rewrite', 'rephrase'])
    // hedge (cut, rephrase) then nominal (rephrase, rewrite): 'rephrase' is shared.
    expect(implVerbs(statsWithAxes(['hedge', 'nominal']))).toEqual(['cut', 'rephrase', 'rewrite'])
  })

  it('flattens many axes, preserving axis order then verb order', () => {
    expect(implVerbs(statsWithAxes(['dialogue', 'nominal', 'closing-position']))).toEqual([
      'concept-form',
      'elaborate',
      'rephrase',
      'rewrite',
      'transition',
    ])
  })

  it('ignores unknown axes', () => {
    expect(implVerbs(statsWithAxes(['rhythm', 'not-an-axis']))).toEqual(['cut', 'rewrite'])
  })

  it('drives off real measureWindow output (dialogue fires)', () => {
    const raw = '"This entire passage sits inside dialogue quotes and runs on at length."'
    const s = measureWindow(raw)
    expect(s.axes.has('dialogue')).toBe(true)
    expect(implVerbs(s)).toEqual(['concept-form', 'elaborate'])
  })
})
describe('purity', () => {
  it('is deterministic: same input twice yields deep-equal output', () => {
    const raw = '“Hello,” she said calmly, and then a decision was made quickly.'
    expect(measureWindow(raw)).toEqual(measureWindow(raw))
  })
})
