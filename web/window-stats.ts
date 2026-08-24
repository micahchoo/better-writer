/**
 * window-stats: pure, deterministic measurement of a markdown window's prose,
 * feeding the seed-card targeting experiment. Computes structural metrics
 * (dialogue density, sentence shape, adverb/hedge rate, filter-verb rate,
 * nominalization + passive rate) and flags the axes whose thresholds fire.
 *
 * The caller's raw window is NEVER mutated: an internal strip pass produces a
 * plain-prose view used only for measurement.
 *
 * Strip pass (internal only):
 *  - fenced code blocks and inline code spans removed
 *  - markdown images (`![alt](url)`) removed entirely; links (`[label](url)`)
 *    keep the visible label but drop the destination URL so it cannot inflate
 *    word counts
 *  - heading lines excluded from sentence stats
 *  - emphasis/list markers stripped
 *
 * Zero imports from other project files; no runtime imports at all.
 */

export interface WindowStats {
  /** Flagged axes; a subset of the seven axis names below. */
  axes: Set<string>;
  /** Raw measurements. */
  values: {
    /** Char share inside double-quote spans (straight `"` and curly `“ ”`); apostrophes never open a span. */
    dialogueDensity: number;
    /** Mean words per sentence over stripped prose. */
    sentenceMean: number;
    /** Population stddev of words per sentence. */
    sentenceSigma: number;
    /** Count of sentences longer than 40 words. */
    longSentences: number;
    /** (-ly adverbs + hedge words) per 100 words. */
    adverbRate: number;
    /** felt/seemed/noticed/realized/watched/wondered per 100 words. */
    filterRate: number;
    /** (suffix nominalizations + passive-proxy sentences) per 100 words. */
    nominalRate: number;
  };
}

export interface PositionContext {
  sectionBlockCount: number;
  blockIndexInSection: number;
}

const AXIS_DIALOGUE = 'dialogue';
const AXIS_RHYTHM = 'rhythm';
const AXIS_HEDGE = 'hedge';
const AXIS_FILTER_WORD = 'filter-word';
const AXIS_NOMINAL = 'nominal';
const AXIS_OPENING = 'opening-position';
const AXIS_CLOSING = 'closing-position';

/** The seven axes measureWindow can flag. */
export type AxisName =
  | 'dialogue'
  | 'rhythm'
  | 'hedge'
  | 'filter-word'
  | 'nominal'
  | 'opening-position'
  | 'closing-position';

/**
 * Implementation-verb buckets per fired axis, in steering-priority order.
 * When an axis fires, the writer is pointed at these verbs first. Shared with
 * the server's /ask flow via implVerbs(), which narrows the seed draw with
 * `--lean-verbs` — a soft preference, never an empty bucket.
 */
export const IMPL_VERBS: Record<AxisName, readonly string[]> = {
  dialogue: ['concept-form', 'elaborate'],
  rhythm: ['cut', 'rewrite'],
  hedge: ['cut', 'rephrase'],
  'filter-word': ['rewrite', 'elaborate'],
  nominal: ['rephrase', 'rewrite'],
  'opening-position': ['concept-form', 'elaborate'],
  'closing-position': ['transition', 'elaborate'],
};

/**
 * Union the implementation verbs for every fired axis in a window, deduped,
 * preserving first-seen order: the order the axes fired (set insertion order),
 * then each axis's own verb order. An empty axis set yields [].
 */
export function implVerbs(stats: WindowStats): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const axis of stats.axes) {
    const verbs = IMPL_VERBS[axis as AxisName];
    if (verbs === undefined) continue;
    for (const verb of verbs) {
      if (!seen.has(verb)) {
        seen.add(verb);
        out.push(verb);
      }
    }
  }
  return out;
}

/** Dialogue spans: straight and curly double quotes. Apostrophes are ignored. */
const QUOTE_SPAN_RE = /"([^"\n]*)"|“([^”\n]*)”/g;

/** Hedges (deduped from the contract list; "somewhat" appears twice there). */
const HEDGES: Record<string, true> = {
  very: true, really: true, quite: true, somewhat: true, just: true,
  simply: true, actually: true, literally: true, suddenly: true,
  truly: true, extremely: true, relatively: true,
};

const FILTER_VERBS: Record<string, true> = {
  felt: true, seemed: true, noticed: true, realized: true, watched: true, wondered: true,
};

const NOMINAL_SUFFIX_RE = /(?:tion|ment|ance|ence|ity|ness)$/i;

/**
 * Passive-voice proxy: `was/were` + a past-participle. Requires the `-ed`
 * word to be at least four letters (so three-letter adjectives like `red`,
 * `fed`, `bed` cannot match) and captures it so the caller can exclude
 * stative predicate adjectives (see STATIVE_ED).
 */
const PASSIVE_PROXY_RE = /\b(?:was|were)\b\s+([a-z]{2,}ed)\b/i;

/**
 * `-ed` words that read as stative predicate adjectives, not verbal passives,
 * after `was`/`were` ("she was tired", "they were scared"). The passive proxy
 * skips these so it flags genuine passives rather than states.
 */
const STATIVE_ED: Record<string, true> = {
  tired: true, bored: true, scared: true, worried: true, excited: true,
  surprised: true, confused: true, annoyed: true, pleased: true,
  interested: true, disappointed: true, frustrated: true, embarrassed: true,
  exhausted: true, frightened: true, shocked: true, amused: true,
  relieved: true, satisfied: true, thrilled: true, delighted: true,
  depressed: true, amazed: true, astonished: true, puzzled: true,
  concerned: true, disturbed: true, alarmed: true, moved: true,
};

/**
 * `-ly` words that are not adverbs: nouns, verbs, and adjectives whose final
 * `ly` is not a productive adverbial suffix ("family", "supply", "holy").
 * The bare `endsWith('ly')` test flags these; an explicit exclusion keeps the
 * metric on true adverbs without needing a dictionary.
 */
const NON_ADVERB_LY: Record<string, true> = {
  ally: true, apply: true, belly: true, bully: true, chilly: true, dally: true,
  family: true, folly: true, frilly: true, gully: true, hilly: true, holy: true,
  imply: true, italy: true, jolly: true, july: true, lily: true, only: true,
  rally: true, reply: true, sally: true, silly: true, supply: true, tally: true,
  ugly: true, wily: true,
};

/** Common function words; a suffix-matched word in this set is not "content". */
const STOPWORDS: Record<string, true> = {
  a: true, an: true, the: true, and: true, or: true, but: true, nor: true, so: true, for: true, yet: true,
  of: true, to: true, in: true, on: true, at: true, by: true, with: true, from: true, as: true, into: true,
  through: true, during: true, before: true, after: true, above: true, below: true, up: true, down: true,
  is: true, are: true, was: true, were: true, be: true, been: true, being: true, am: true,
  have: true, has: true, had: true, do: true, does: true, did: true, will: true, would: true, shall: true, should: true,
  may: true, might: true, must: true, can: true, could: true,
  i: true, you: true, he: true, she: true, it: true, we: true, they: true, me: true, him: true, her: true, us: true, them: true,
  my: true, your: true, his: true, its: true, our: true, their: true, mine: true, yours: true, hers: true, ours: true, theirs: true,
  this: true, that: true, these: true, those: true,
  there: true, here: true, where: true, when: true, why: true, how: true,
  which: true, who: true, whom: true, whose: true, what: true,
  if: true, then: true, else: true, than: true, because: true, while: true, though: true, although: true,
  not: true, no: true, yes: true, off: true, out: true, over: true, under: true, again: true, further: true,
  hence: true, thence: true, whence: true,
};

/** A prose token: letters, with optional internal apostrophes/hyphens. */
const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;

/**
 * Reduce markdown to plain prose for measurement. The result is only used
 * internally and never exposed to callers.
 */
function stripMarkdown(raw: string): string {
  let s = raw;
  // Cursor-marker transport tokens ([CURSOR START]/[CURSOR END]) are plumbing,
  // never writer prose; strip them first (as spaces, so adjacent words stay
  // separate) so their words cannot join the token stream or the sentence
  // splitter's input.
  s = s.split('[CURSOR START]').join(' ').split('[CURSOR END]').join(' ');
  // Fenced code blocks.
  s = s.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ');
  // Inline code spans.
  s = s.replace(/`[^`\n]*`/g, ' ');
  // Images: drop entirely (alt text is not visible prose).
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  // Links: keep the visible label, drop the destination URL.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, ' $1 ');
  // Heading lines: exclude their text from sentence stats.
  s = s.replace(/^#{1,6}(?:\s|$).*$/gm, ' ');
  // List markers at line start.
  s = s.replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+/gm, ' ');
  // Remaining emphasis / strikethrough markers.
  s = s.replace(/[*_~]/g, ' ');
  return s;
}

/**
 * Split prose into sentences at `.`/`!`/`?`, tolerating a trailing closing
 * quote. A quote only ends a sentence when it directly follows a terminator,
 * so possessives ("the writers' guild") and inline quotes ("said "hello" and")
 * never split a sentence.
 */
function splitSentences(prose: string): string[] {
  return prose
    .split(/(?<=[.!?][”’"']*)(?:\s+|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function measureWindow(
  rawWindow: string,
  positionContext?: PositionContext,
): WindowStats {
  const prose = stripMarkdown(rawWindow);
  const totalChars = prose.length;

  // Dialogue density: char share inside double-quote spans.
  let insideQuoteChars = 0;
  QUOTE_SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUOTE_SPAN_RE.exec(prose)) !== null) {
    insideQuoteChars += (m[1] ?? m[2] ?? '').length;
  }
  const dialogueDensity = totalChars > 0 ? insideQuoteChars / totalChars : 0;

  // Sentence shape.
  const sentences = splitSentences(prose);
  const sentenceLengths = sentences.map((sentence) => (sentence.match(WORD_RE) ?? []).length);
  const n = sentenceLengths.length;
  const sentenceMean = n > 0 ? sentenceLengths.reduce((a, b) => a + b, 0) / n : 0;
  const variance =
    n > 0 ? sentenceLengths.reduce((acc, len) => acc + (len - sentenceMean) ** 2, 0) / n : 0;
  const sentenceSigma = Math.sqrt(variance);
  const longSentences = sentenceLengths.filter((len) => len > 40).length;

  const words = prose.match(WORD_RE) ?? [];
  const totalWords = words.length;

  // Adverb + hedge rate.
  let adverbHedgeCount = 0;
  for (const w of words) {
    const lower = w.toLowerCase();
    if (
      Object.hasOwn(HEDGES, lower) ||
      (w.length > 3 && lower.endsWith('ly') && !Object.hasOwn(NON_ADVERB_LY, lower))
    ) {
      adverbHedgeCount++;
    }
  }
  const adverbRate = totalWords > 0 ? (adverbHedgeCount / totalWords) * 100 : 0;

  // Filter-verb rate.
  let filterCount = 0;
  for (const w of words) {
    if (Object.hasOwn(FILTER_VERBS, w.toLowerCase())) filterCount++;
  }
  const filterRate = totalWords > 0 ? (filterCount / totalWords) * 100 : 0;

  // Nominalization + passive rate: suffix content words plus one credit per
  // sentence exhibiting a `was/were` + `-ed` passive proxy.
  let nominalCount = 0;
  for (const w of words) {
    const lower = w.toLowerCase();
    if (NOMINAL_SUFFIX_RE.test(lower) && !Object.hasOwn(STOPWORDS, lower)) {
      nominalCount++;
    }
  }
  for (const sentence of sentences) {
    const m = PASSIVE_PROXY_RE.exec(sentence);
    if (m && !Object.hasOwn(STATIVE_ED, m[1].toLowerCase())) nominalCount++;
  }
  const nominalRate = totalWords > 0 ? (nominalCount / totalWords) * 100 : 0;

  // Axes.
  const axes = new Set<string>();
  if (dialogueDensity >= 0.25) axes.add(AXIS_DIALOGUE);
  if (sentenceMean > 30 && sentenceSigma < 12) axes.add(AXIS_RHYTHM);
  if (adverbRate > 4) axes.add(AXIS_HEDGE);
  if (filterRate > 2) axes.add(AXIS_FILTER_WORD);
  if (nominalRate > 5) axes.add(AXIS_NOMINAL);
  if (positionContext) {
    const { sectionBlockCount, blockIndexInSection } = positionContext;
    if (sectionBlockCount >= 3 && blockIndexInSection === 0) axes.add(AXIS_OPENING);
    if (sectionBlockCount >= 3 && blockIndexInSection === sectionBlockCount - 1) {
      axes.add(AXIS_CLOSING);
    }
  }

  return {
    axes,
    values: {
      dialogueDensity,
      sentenceMean,
      sentenceSigma,
      longSentences,
      adverbRate,
      filterRate,
      nominalRate,
    },
  };
}
