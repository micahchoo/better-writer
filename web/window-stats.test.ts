import { describe, expect, it } from 'vitest'
import { countProseWords, implVerbs, IMPL_VERBS, measureWindow, type WindowStats } from '../src/core/window-stats'

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

  it('does not count ordinary -ly nouns, verbs, or adjectives as adverbs', () => {
    const raw = 'The family reply was only a supply of holy folly. Italy rally ugly.'
    const s = measureWindow(raw)
    expect(s.values.adverbRate).toBe(0)
    expect(s.axes.has('hedge')).toBe(false)
  })

  it('still counts a genuine -ly adverb', () => {
    const raw = passage('quickly', 20) // 1 / 20 = 5%
    const s = measureWindow(raw)
    expect(s.values.adverbRate).toBeCloseTo(5)
    expect(s.axes.has('hedge')).toBe(true)
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

  it('does not flag three-letter adjectives or stative predicate adjectives as passive', () => {
    const raw = 'She was tired. He was bored. They were scared. It was red.'
    const s = measureWindow(raw)
    expect(s.values.nominalRate).toBe(0)
    expect(s.axes.has('nominal')).toBe(false)
  })

  it('still counts a genuine past-participle passive', () => {
    const raw = 'The gate was opened by the guard.'
    const s = measureWindow(raw)
    expect(s.values.nominalRate).toBeGreaterThan(0)
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

describe('sentence splitting', () => {
  it('does not split a sentence on a possessive apostrophe', () => {
    const possessive =
      "The writers' guild met. The editors' room stayed dark. Nothing else happened at all."
    const plain =
      'The writers guild met. The editors room stayed dark. Nothing else happened at all.'
    expect(measureWindow(possessive).values.sentenceMean).toBe(measureWindow(plain).values.sentenceMean)
    expect(measureWindow(possessive).values.sentenceSigma).toBe(measureWindow(plain).values.sentenceSigma)
  })

  it('does not split a sentence on a mid-sentence inline quote', () => {
    const raw = 'He said "hello" and then left the building without another word to anyone there.'
    const s = measureWindow(raw)
    // One sentence: the closing quote after "hello" must not terminate it.
    expect(s.values.sentenceSigma).toBe(0)
    expect(s.values.sentenceMean).toBe(14)
  })

  it('splits after a terminator that closes a quoted sentence', () => {
    const raw = 'She said "goodbye." Then she left.'
    const s = measureWindow(raw)
    expect(s.values.sentenceMean).toBe(3) // "She said goodbye" + "Then she left"
    expect(s.values.sentenceSigma).toBe(0)
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

  it('strips cursor markers so they never distort any measurement', () => {
    const clean =
      'The writers guild met. The editors room stayed dark. Nothing else happened at all.'
    const markedLines =
      '[CURSOR START]\nThe writers guild met.\n[CURSOR END]\n\nThe editors room stayed dark. Nothing else happened at all.'
    const markedInline =
      'The writers [CURSOR START] guild met. The editors [CURSOR END] room stayed dark. Nothing else happened at all.'
    const cleanValues = measureWindow(clean).values
    expect(measureWindow(markedLines).values).toEqual(cleanValues)
    expect(measureWindow(markedInline).values).toEqual(cleanValues)
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

/**
 * R2/R3: both metrics were "fixed" with exclusion tables sized to the words a
 * single probe string happened to contain, so the probe passed while ordinary
 * prose still scored a higher false rate than the real thing. These tests hold
 * the metrics to a RATE over passages the fix was not written from, which is
 * the only shape of test that can catch a table shaped to its own probe.
 */
describe('adverbRate — the -ly class, not the probe words (R2)', () => {
  /** Prose deliberately loaded with -ly words that are NOT adverbs. */
  const NON_ADVERB_PROSE = [
    'She was lonely. The lovely garden felt friendly. A deadly quiet settled.',
    'It was likely costly. The elderly neighbour kept an orderly, timely house.',
    'The assembly met. He felt melancholy. An anomaly appeared; the monopoly grew.',
    'They rely on it. Numbers multiply. Bees comply. We supply pressure and apply it.',
    'The family gathered on the hilly, chilly ground beside the ugly holly.',
    'A butterfly, a dragonfly, and one silly jolly bully crossed the weekly ledger.',
  ]

  it('scores zero adverbs across prose full of -ly non-adverbs', () => {
    for (const prose of NON_ADVERB_PROSE) {
      expect(measureWindow(prose).values.adverbRate).toBe(0)
    }
  })

  it('never fires the hedge axis on that prose', () => {
    for (const prose of NON_ADVERB_PROSE) {
      expect(measureWindow(prose).axes.has('hedge')).toBe(false)
    }
  })

  it('still counts genuine -ly adverbs, and fires the axis on them', () => {
    const s = measureWindow('She quickly walked. He slowly turned. It suddenly stopped.')
    expect(s.values.adverbRate).toBeGreaterThan(4)
    expect(s.axes.has('hedge')).toBe(true)
  })

  it('keeps words that are both adjective and manner adverb', () => {
    // "kindly" is deliberately absent from the exclusion table.
    expect(measureWindow('He kindly agreed to wait.').values.adverbRate).toBeGreaterThan(0)
  })
})

describe('nominalRate — passives need an explicit marker (R3)', () => {
  it('counts a passive with an agent phrase, regular or irregular participle', () => {
    expect(measureWindow('The window was destroyed by the storm.').values.nominalRate).toBeGreaterThan(0)
    expect(measureWindow('The window was broken by the storm.').values.nominalRate).toBeGreaterThan(0)
    expect(measureWindow('The vase was quietly removed by the maid.').values.nominalRate).toBeGreaterThan(0)
  })

  it('counts a progressive passive, which has no adjectival reading', () => {
    expect(measureWindow('The bridge was being repaired.').values.nominalRate).toBeGreaterThan(0)
  })

  it('scores zero on predicate adjectives, whatever the participle', () => {
    // None of these were in the old STATIVE_ED table; all of them scored.
    for (const prose of [
      'She was ashamed. He was determined. They were convinced.',
      'The door was locked. The sky was clouded. His voice was strained.',
      'She was tired. He was bored. They were scared. It was red.',
      'The room was finished. The plan was settled. The matter was closed.',
    ]) {
      const s = measureWindow(prose)
      expect(s.values.nominalRate).toBe(0)
      expect(s.axes.has('nominal')).toBe(false)
    }
  })

  it('does not mistake an ordinary -en word before "by" for a participle', () => {
    expect(measureWindow('He was often by the window.').values.nominalRate).toBe(0)
    expect(measureWindow('She was tired by then.').values.nominalRate).toBe(0)
  })

  it('accepts the known cost: an agentless passive is not counted', () => {
    // Documented in the PASSIVE_AGENT_RE comment — precision over recall.
    expect(measureWindow('The letters were burned.').values.nominalRate).toBe(0)
  })

  it('still counts suffix nominalizations, the metric primary contributor', () => {
    const s = measureWindow('The implementation of the arrangement showed a certain hesitance.')
    expect(s.values.nominalRate).toBeGreaterThan(5)
    expect(s.axes.has('nominal')).toBe(true)
  })
})

/**
 * H1-4/H1-6: R2 closed the -ly adjective/noun/verb classes with a table, but
 * proper nouns ending in -ly are an OPEN class no table can close, and the
 * table's own docstring contradicted the frequency words sitting in it.
 */
describe('adverbRate — proper nouns and axis scope (H1-4, H1-6)', () => {
  it('does not count a name ending in -ly, wherever it sits', () => {
    for (const name of ['Emily', 'Kelly', 'Wally', 'Sicily', 'Tully', 'Shelly', 'Beverly', 'Kimberly']) {
      const s = measureWindow(`${name} left the room without saying one word to him`)
      expect(s.values.adverbRate).toBe(0)
      expect(s.axes.has('hedge')).toBe(false)
    }
    expect(measureWindow('She told Kelly to wait here now.').values.adverbRate).toBe(0)
    expect(measureWindow('The letter from Beverly arrived.').values.adverbRate).toBe(0)
  })

  it('still counts an adverb that opens a sentence', () => {
    // Capitalized like a name, but followed by the subject or a comma.
    for (const prose of [
      'Slowly he turned to face her.',
      'Quietly, she left the room.',
      'Carefully the door opened wide.',
      'Grimly they marched on.',
    ]) {
      expect(measureWindow(prose).values.adverbRate).toBeGreaterThan(0)
    }
  })

  it('still counts an ordinary mid-sentence adverb', () => {
    expect(measureWindow('He turned slowly to face her.').values.adverbRate).toBeGreaterThan(0)
    expect(measureWindow('Emily left the room quietly.').values.adverbRate).toBeGreaterThan(0)
  })

  it('excludes frequency and time -ly words, per the axis manner scope', () => {
    // H1-6: these ARE adverbs, but they modify when, not how, so they sit
    // outside what the hedge axis measures. The docstring now says so.
    expect(measureWindow('She arrives early. He trains daily. They meet weekly.').values.adverbRate).toBe(0)
    // A manner adverb that doubles as an adjective still counts.
    expect(measureWindow('He kindly agreed to wait for her.').values.adverbRate).toBeGreaterThan(0)
  })
})

/**
 * H1-1/H1-2/H1-3/H1-7: four more heuristics keyed on exact tables, a bare
 * suffix test, and character classes rather than the English class they name.
 */
describe('filterRate — every inflection, not six past-tense forms (H1-1)', () => {
  const same = 'She {feel} it. He {seem} tired. They {notice}. She {realize}. He {watch}. She {wonder}.'
  const forms = {
    past: ['felt', 'seemed', 'noticed', 'realized', 'watched', 'wondered'],
    present: ['feels', 'seems', 'notices', 'realizes', 'watches', 'wonders'],
    gerund: ['feeling', 'seeming', 'noticing', 'realizing', 'watching', 'wondering'],
  }
  const build = (fs: string[]) =>
    same.replace('{feel}', fs[0]).replace('{seem}', fs[1]).replace('{notice}', fs[2])
      .replace('{realize}', fs[3]).replace('{watch}', fs[4]).replace('{wonder}', fs[5])

  it('fires the axis regardless of tense', () => {
    for (const [label, fs] of Object.entries(forms)) {
      const s = measureWindow(build(fs))
      expect(s.axes.has('filter-word'), label).toBe(true)
      expect(s.values.filterRate, label).toBeGreaterThan(2)
    }
  })

  it('accepts the British -ise spelling', () => {
    expect(measureWindow('She realised it was late.').values.filterRate).toBeGreaterThan(0)
  })
})

describe('splitSentences — abbreviations and ellipses (H1-2)', () => {
  it('does not split on a title dot', () => {
    const withTitles = measureWindow('Mr. Darcy wrote. Mrs. Smith read. Dr. Lee slept. St. John waited.')
    // Four sentences of three words each: mean 3, no spread.
    expect(withTitles.values.sentenceMean).toBe(3)
    expect(withTitles.values.sentenceSigma).toBe(0)
  })

  it('does not split inside an ellipsis', () => {
    const a = measureWindow('He walked down the hall... then paused. She waited.')
    const b = measureWindow('He walked down the hall then paused. She waited.')
    expect(a.values.sentenceMean).toBe(b.values.sentenceMean)
  })

  it('still splits ordinary sentences, including after a closing quote', () => {
    const s = measureWindow('"Go home," she said. He stayed where he was.')
    expect(s.values.sentenceMean).toBeGreaterThan(0)
    expect(measureWindow('One two three. Four five six.').values.sentenceMean).toBe(3)
  })

  it('keeps splitting after words that merely look like abbreviations', () => {
    // "no" and "etc" are deliberately absent from the table, so the dot after
    // "no" still ends a sentence: two sentences (3 words, 2 words) -> mean 2.5,
    // not one 5-word sentence.
    expect(measureWindow('She said no. He left.').values.sentenceMean).toBe(2.5)
  })
})

describe('nominalRate — suffix spelling is not a nominalization (H1-3)', () => {
  it('does not count words whose ending is not a suffix', () => {
    const s = measureWindow('They mention the witness and comment on the garment.')
    expect(s.values.nominalRate).toBe(0)
    expect(s.axes.has('nominal')).toBe(false)
  })

  it('does not count a suffix word used as a verb', () => {
    // "mention" IS deverbal, so it is not in the exclusion table; the noun
    // -position test is what keeps the verb use out.
    expect(measureWindow('They mention it often.').values.nominalRate).toBe(0)
  })

  it('still counts real nominalizations in noun position', () => {
    const s = measureWindow('The implementation of the arrangement showed a certain hesitance.')
    expect(s.values.nominalRate).toBeGreaterThan(5)
    expect(s.axes.has('nominal')).toBe(true)
  })
})

describe('dialogueDensity — hard-wrapped speech (H1-7)', () => {
  it('scores wrapped speech the same as unwrapped', () => {
    const wrapped = measureWindow('"I cannot believe\nyou did that," she said.')
    const flat = measureWindow('"I cannot believe you did that," she said.')
    expect(wrapped.values.dialogueDensity).toBeCloseTo(flat.values.dialogueDensity, 10)
    expect(wrapped.axes.has('dialogue')).toBe(true)
  })

  it('still ends a span at a blank line, so an unclosed quote cannot run away', () => {
    const s = measureWindow('"an unclosed quote\n\nA whole separate paragraph of ordinary prose here.')
    expect(s.values.dialogueDensity).toBe(0)
  })
})

describe('countProseWords — cadence and window-stats agree (H1-5)', () => {
  it('does not count markdown scaffolding as words', () => {
    const doc = '# Heading\n\n- one\n- two\n\n```\ncode\n```\n\n---\n\n**bold** and `tick`'
    expect(countProseWords(doc)).toBeLessThan(doc.split(/\s+/).filter(Boolean).length)
  })

  it('counts the same words measureWindow measures', () => {
    const prose = 'She lifted the skillet and set it on the burner.'
    expect(countProseWords(prose)).toBe(10)
  })
})
