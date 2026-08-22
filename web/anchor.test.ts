import { describe, expect, it } from 'vitest'
import { extractAnchor } from './anchor.js'

describe('extractAnchor', () => {
  it('picks the longest fragment fully inside the cursor envelope', () => {
    const draft =
      'The market had been quiet for years. Meanwhile, across town, the new startup district was booming.'
    const anchor = extractAnchor(
      'Why did the quiet market stay quiet while the startup district boomed?',
      draft,
      draft.indexOf('startup'),
    )
    expect(anchor).not.toBeNull()
    expect(anchor!.fragment).toContain('startup district')
  })

  it('anchors the specific content word in a padded sentence', () => {
    const draft =
      'In my own personal opinion, I truly believe that the very first time that I ever saw the ocean, it was, honestly speaking, an experience that was quite literally unforgettable in every possible way.'
    const anchor = extractAnchor(
      'Does every word in your sentence about the ocean serve a specific purpose?',
      draft,
      draft.indexOf('ocean'),
    )
    expect(anchor).not.toBeNull()
    expect(anchor!.fragment).toContain('ocean')
  })

  it('anchors a word near the cursor when the cursor is at the draft start', () => {
    const draft = 'She walked to the store. She bought milk. She came home. The end.'
    const anchor = extractAnchor(
      'What past memory should she dwell on before buying milk?',
      draft,
      0,
    )
    expect(anchor).not.toBeNull()
    expect(anchor!.fragment).toContain('milk')
  })

  it('returns null when no distinctive question word appears in the draft', () => {
    const anchor = extractAnchor('How are you making your dialogue seem natural?', 'The soup was hot.', 3)
    expect(anchor).toBeNull()
  })

  it('matches case-insensitively and returns the raw draft span', () => {
    const draft = 'The OCEAN is vast.'
    const anchor = extractAnchor('why ocean?', draft, draft.indexOf('OCEAN'))
    expect(anchor).not.toBeNull()
    expect(anchor!.fragment).toBe('OCEAN')
  })

  it('strips punctuation at fragment boundaries', () => {
    const draft = 'Then came the ocean, and the shore.'
    const anchor = extractAnchor('why ocean?', draft, draft.indexOf('ocean'))
    expect(anchor).not.toBeNull()
    expect(anchor!.fragment).toBe('ocean')
    expect(anchor!.start).toBe(draft.indexOf('ocean'))
    expect(anchor!.end).toBe(draft.indexOf('ocean') + 'ocean'.length)
  })

  it('matches a word sequence inside a longer draft word', () => {
    const draft = 'The uncanny valley effect is real.'
    const anchor = extractAnchor('canny valley', draft, draft.indexOf('valley'))
    expect(anchor).not.toBeNull()
    expect(anchor!.fragment).toBe('canny valley')
  })

  it('breaks equal-length ties toward the first occurrence in the draft', () => {
    const draft = 'The first market opened early. The second market stayed late.'
    const anchor = extractAnchor('about market?', draft, draft.lastIndexOf('market'))
    expect(anchor).not.toBeNull()
    expect(anchor!.fragment).toBe('market')
    expect(anchor!.start).toBe(draft.indexOf('market'))
  })

  it('handles a cursor at the end of the draft', () => {
    const draft = 'She bought milk. She came home.'
    const anchor = extractAnchor('did she buy milk?', draft, draft.length)
    expect(anchor).not.toBeNull()
    expect(anchor!.fragment).toContain('milk')
  })

  it('anchors the longest fragment when the question equals the draft', () => {
    const draft = 'The quick brown fox jumps over the lazy dog.'
    const anchor = extractAnchor(draft, draft, 10)
    expect(anchor).not.toBeNull()
    expect(anchor!.fragment).toBe('quick brown fox jumps')
  })

  it('prefers the nearest fragment over the longest when both are outside the envelope', () => {
    // 100 occurrences of the long phrase in the first block; the nearest
    // fragment is the single word at the end of that block. The envelope
    // (cursor block plus one before) contains neither fragment.
    const filler = Array.from({ length: 100 }, () => 'alpha beta gamma.').join(' ')
    const draft = `${filler} omega.\n\nMiddle block filler text.\n\nFinal block with the cursor here.`
    const anchor = extractAnchor('alpha beta gamma omega?', draft, draft.indexOf('cursor'))
    expect(anchor).not.toBeNull()
    expect(anchor!.fragment).toBe('omega')
  })

  it('returns null for an empty draft', () => {
    expect(extractAnchor('any question here?', '', 0)).toBeNull()
    expect(extractAnchor('any question here?', '\n\n', 1)).toBeNull()
  })

  it('is unicode-safe and matches non-ASCII words', () => {
    const draft = 'El océano es profundo. 中文测试 no crash.'
    const anchor = extractAnchor('¿Cómo está el océano?', draft, draft.indexOf('océano'))
    expect(anchor).not.toBeNull()
    expect(anchor!.fragment.toLowerCase()).toContain('océano')
  })
})
