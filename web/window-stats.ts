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
    /** (suffix nominalizations + explicitly-marked passive sentences) per 100 words. */
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

/**
 * Dialogue spans: straight and curly double quotes. Apostrophes are ignored.
 *
 * A span may contain SOFT line breaks, so hard-wrapped speech counts the same
 * as unwrapped speech — forbidding `\n` outright scored wrapped dialogue at 0
 * where the identical unwrapped line scored 71% (H1-7). A BLANK line still
 * ends the span: that is a paragraph break, and an unclosed quote must not
 * swallow the rest of the window.
 */
const QUOTE_SPAN_RE = /"((?:[^"\n]|\n(?!\s*\n))*)"|“((?:[^”\n]|\n(?!\s*\n))*)”/g;

/** Hedges (deduped from the contract list; "somewhat" appears twice there). */
const HEDGES: Record<string, true> = {
  very: true, really: true, quite: true, somewhat: true, just: true,
  simply: true, actually: true, literally: true, suddenly: true,
  truly: true, extremely: true, relatively: true,
};

/**
 * Filter verbs — the interiority markers the axis names — in EVERY inflection.
 *
 * The contract fixes the six verbs, so their forms are a closed set and can be
 * enumerated exactly. Listing only the past tense made the axis a tense
 * detector: identical prose scored 40.0 in past tense and 0.0 in present or
 * continuous, so present-tense narration saturated with interiority got no
 * steering at all (H1-1).
 */
const FILTER_VERBS: Record<string, true> = {
  feel: true, feels: true, feeling: true, felt: true,
  seem: true, seems: true, seeming: true, seemed: true,
  notice: true, notices: true, noticing: true, noticed: true,
  realize: true, realizes: true, realizing: true, realized: true,
  realise: true, realises: true, realising: true, realised: true,
  watch: true, watches: true, watching: true, watched: true,
  wonder: true, wonders: true, wondering: true, wondered: true,
};

const NOMINAL_SUFFIX_RE = /(?:tion|ment|ance|ence|ity|ness)$/i;

/**
 * Words whose ending only LOOKS like a nominalizing suffix — there is no verb
 * underneath. `NOMINAL_SUFFIX_RE` is a spelling test, so "moment" alone used
 * to cross the 5% threshold in a short window (H1-3).
 *
 * Same asymmetry that justifies NON_ADVERB_LY: nominalization is productive
 * (any verb yields one), while the basic-vocabulary words that merely end in
 * these letters are a finite set. Words that ARE deverbal ("mention", "the
 * question") stay out of this table — a verb USE of them is handled by the
 * noun-context test in measureWindow instead.
 */
const NOT_A_NOMINALIZATION: Record<string, true> = {
  // -ment
  moment: true, comment: true, garment: true, cement: true, torment: true,
  fragment: true, ornament: true, monument: true, document: true,
  instrument: true, element: true, parliament: true, tournament: true,
  apartment: true, compartment: true, regiment: true, condiment: true,
  rudiment: true, segment: true, pigment: true, filament: true,
  testament: true, temperament: true, lament: true, sediment: true,
  // -tion
  station: true, nation: true, ration: true, caution: true, portion: true,
  potion: true, motion: true, lotion: true, notion: true, fiction: true,
  auction: true, friction: true, faction: true, suction: true,
  // -ness
  witness: true, business: true, harness: true, highness: true,
  // -ity
  city: true, pity: true, entity: true, deity: true, unity: true,
  parity: true, cavity: true, gravity: true, vanity: true, charity: true,
  // -ance
  dance: true, chance: true, glance: true, balance: true, distance: true,
  romance: true, finance: true, france: true, lance: true, trance: true,
  nuisance: true, substance: true,
  // -ence
  fence: true, hence: true, science: true, silence: true, sentence: true,
  essence: true, influence: true, sequence: true, licence: true,
  defence: true, whence: true,
};

/**
 * Words that put the NEXT word in noun position. A suffix word is only a
 * nominalization when something like this precedes it — "the implementation",
 * "of the arrangement" — which is what separates the noun from the verb use
 * ("they MENTION the witness", "and COMMENT on the garment").
 */
const NOUN_INTRODUCER: Record<string, true> = {
  the: true, a: true, an: true, this: true, that: true, these: true,
  those: true, its: true, his: true, her: true, their: true, our: true,
  my: true, your: true, of: true, in: true, on: true, at: true, to: true,
  for: true, with: true, from: true, by: true, into: true, through: true,
  about: true, without: true, under: true, over: true, between: true,
  any: true, no: true, some: true, each: true, every: true, such: true,
  more: true, most: true, less: true, one: true, certain: true, whole: true,
  same: true, other: true, another: true, much: true,
};

/**
 * Passive-voice proxy, deliberately HIGH PRECISION and low recall.
 *
 * A bare `was/were` + `-ed` word is NOT a passive signal. In prose that shape
 * is more often a predicate adjective — "she was tired", "he was determined",
 * "the door was locked", "his voice was strained" — and the two cannot be
 * separated by a word list, because almost any transitive verb's participle
 * can stand predicatively. An exclusion table for this class would have to be
 * open-ended, and a short one only silences the examples it was written from
 * while the rate stays wrong (R3).
 *
 * So only a construction carrying an EXPLICIT passive marker counts:
 *  - an agent phrase — "was broken BY the storm" (up to two intervening
 *    words, so "was quietly broken by …" still reads),
 *  - the progressive passive — "was BEING broken", which has no adjectival
 *    reading at all.
 *
 * The participle may end in `-ed` or `-en`, so the large irregular class
 * (broken, taken, written, chosen, stolen, driven) is not thrown away.
 * `NOT_A_PARTICIPLE` guards the handful of ordinary words with those endings
 * that can legitimately sit before `by` ("he was often by the window") — a
 * guard on a positional pattern, not an attempt to enumerate participles.
 *
 * The cost is real: "The letters were burned." is a genuine agentless passive
 * and is not counted. That is the right trade here — the passive credit is a
 * bonus on top of `nominalRate`'s primary suffix count, and a bonus that
 * fires on the wrong sentences is worse than one that fires on fewer.
 */
const PASSIVE_AGENT_RE = /\b(?:was|were)\s+(?:\w+\s+){0,2}?(\w{3,}(?:ed|en))\s+by\b/i;
const PASSIVE_PROGRESSIVE_RE = /\b(?:was|were)\s+being\s+\w{3,}(?:ed|en)\b/i;

/** `-ed`/`-en` words that are not participles and can precede an agent `by`. */
const NOT_A_PARTICIPLE: Record<string, true> = {
  often: true, even: true, then: true, when: true, green: true, open: true,
  red: true, tired: true, keen: true, seldom: true,
};

/**
 * `-ly` words that are not adverbs.
 *
 * The bare `endsWith('ly')` test cannot tell an adverb from anything else
 * ending in those two letters. An exclusion table is the right instrument
 * here — but only because of an asymmetry in English: `-ly` ADVERBS are an
 * open, productive class (any new adjective yields one), while `-ly`
 * ADJECTIVES are a CLOSED class, and `-ly` nouns and verbs are a finite set.
 * So the words that must be excluded can be enumerated, and the words that
 * must be kept cannot — which is exactly the right way round.
 *
 * That makes completeness the standard this table is held to. It must cover
 * the closed classes, not the examples that happened to expose the bug: an
 * earlier 26-word version listed only the words one probe string contained,
 * so ordinary fiction ("lonely", "lovely", "friendly", "deadly") still scored
 * a higher adverb rate than genuine adverbs did (R2).
 *
 * SCOPE: this axis targets MANNER adverbs — the ones that dilute a verb
 * instead of letting it carry the sentence, which is the craft note the axis
 * steers toward. Frequency and time words (early, daily, weekly, monthly,
 * nightly, hourly, quarterly, yearly) are therefore listed even though they
 * ARE adverbs in some uses: they modify when, not how, so they are outside
 * what the axis measures. Manner adverbs that double as adjectives — "kindly",
 * "fully", "wholly" — are deliberately absent, so their adverbial use counts.
 * (An earlier version of this comment claimed dual-class words were kept as a
 * rule, which contradicted the frequency words sitting in the table: H1-6.)
 *
 * The table cannot reach PROPER NOUNS ending in -ly (Emily, Kelly, Beverly,
 * Sicily) — those are an open class, and no list closes it. They are handled
 * structurally instead, by capitalization; see the adverb loop in
 * measureWindow (H1-4).
 */
const NON_ADVERB_LY: Record<string, true> = {
  // -ly ADJECTIVES (closed class)
  beastly: true, beggarly: true, bodily: true, bristly: true, brotherly: true,
  bubbly: true, burly: true, chilly: true, comely: true, costly: true,
  courtly: true, cowardly: true, crinkly: true, crumbly: true, cuddly: true,
  curly: true, daily: true, dastardly: true, deadly: true, disorderly: true,
  drizzly: true, early: true, earthly: true, elderly: true, fatherly: true,
  friendly: true, frilly: true, gangly: true, ghastly: true, ghostly: true,
  giggly: true, gnarly: true, godly: true, goodly: true, gravelly: true,
  grisly: true, gristly: true, grizzly: true, heavenly: true, hilly: true,
  holy: true, homely: true, hourly: true, jiggly: true, jolly: true,
  kingly: true, knightly: true, likely: true, lively: true, lonely: true,
  lordly: true, lovely: true, lowly: true, manly: true, masterly: true,
  measly: true, miserly: true, monthly: true, motherly: true, neighborly: true,
  neighbourly: true, nightly: true, oily: true, only: true, orderly: true,
  portly: true, prickly: true, princely: true, quarterly: true, queenly: true,
  rumbly: true, saintly: true, scaly: true, scholarly: true, seemly: true,
  shapely: true, sickly: true, silly: true, sisterly: true, smelly: true,
  sparkly: true, sprightly: true, squiggly: true, stately: true, steely: true,
  surly: true, timely: true, ugly: true, ungainly: true, unfriendly: true,
  unlikely: true, unruly: true, unseemly: true, unsightly: true,
  untimely: true, unworldly: true, weekly: true, wiggly: true, wily: true,
  wobbly: true, womanly: true, woolly: true, worldly: true, wriggly: true,
  wrinkly: true, yearly: true,
  // -ly NOUNS (finite)
  ally: true, anomaly: true, assembly: true, barfly: true, belly: true,
  bully: true, butterfly: true, doily: true, dolly: true, dragonfly: true,
  family: true, firefly: true, folly: true, gadfly: true, gully: true,
  holly: true, homily: true, horsefly: true, italy: true, jelly: true,
  july: true, lily: true, mayfly: true, melancholy: true, molly: true,
  monopoly: true, panoply: true,
  // -ly VERBS (finite)
  apply: true, comply: true, dally: true, imply: true, multiply: true,
  rally: true, rely: true, reply: true, sally: true, supply: true, tally: true,
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
/** True when the word starts with an uppercase letter. */
function isCapitalized(w: string): boolean {
  const first = w[0];
  return first !== undefined && first !== first.toLowerCase();
}

/**
 * Words that can follow a sentence-opening adverb but never a subject noun.
 * "Slowly HE turned" / "Suddenly THE door opened" are adverbial; "Emily LEFT"
 * is a subject followed by its verb.
 */
const SUBJECT_FOLLOWER: Record<string, true> = {
  he: true, she: true, it: true, they: true, we: true, you: true, i: true,
  the: true, a: true, an: true, this: true, that: true, these: true,
  those: true, his: true, her: true, their: true, its: true, our: true,
  my: true, your: true, there: true, everyone: true, no: true, one: true,
  someone: true, nobody: true, everything: true, nothing: true,
};

/**
 * A capitalized `-ly` word is a proper noun (Emily, Kelly, Beverly) UNLESS it
 * is opening a sentence adverbially. Proper nouns are an open class, so no
 * exclusion table can hold them (H1-4); capitalization is the only evidence
 * available without a lexicon, and it is decisive everywhere except at a
 * sentence start, where an adverb is capitalized too.
 *
 * At a sentence start the two are separated by what FOLLOWS: an adverb is
 * followed by a comma or by the subject ("Slowly, he turned" / "Suddenly the
 * door opened"), while a name IS the subject and is followed by its verb
 * ("Emily left the room"). Mid-sentence, a capitalized `-ly` word is a name.
 */
function isAdverbialSentenceOpener(prose: string, index: number, word: string): boolean {
  let i = index - 1;
  while (i >= 0 && /\s/.test(prose[i])) i--;
  const opensSentence = i < 0 || /[.!?]/.test(prose[i]);
  if (!opensSentence) return false;
  let j = index + word.length;
  if (prose[j] === ',') return true;
  while (j < prose.length && /\s/.test(prose[j])) j++;
  const next = prose.slice(j).match(/^[A-Za-z][A-Za-z'-]*/);
  return next !== null && Object.hasOwn(SUBJECT_FOLLOWER, next[0].toLowerCase());
}

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
/**
 * Abbreviations whose dot is not a sentence end. Titles dominate fiction, so
 * splitting on them was wrong by ~3x there (H1-2). Deliberately excludes
 * "etc" and "no", which routinely DO end a sentence.
 */
const ABBREVIATION_RE =
  /(?:^|[\s("'“‘])(?:mr|mrs|ms|mx|dr|prof|rev|hon|sr|jr|st|mt|lt|sgt|capt|gen|col|adm|gov|pres|dept|fig|vol|ch|pp|approx|al|vs|cf|viz|e\.g|i\.e)$/i;

/** Candidate sentence ends: a terminator, any closing marks, then a gap. */
const SENTENCE_BREAK_RE = /[.!?][”’"')\]]*(?:\s+|$)/g;

/**
 * The number of PROSE words in a markdown window: the same count the metrics
 * below are computed from, with markdown scaffolding stripped first.
 *
 * Exported because `cadence` needs it. Counting raw whitespace tokens there
 * meant `##`, `**`, backticks, `-` bullets and `---` all counted as words, so
 * a structure-only document of 23 real words measured 61 and tripped the
 * 30-word auto-ask threshold — a coaching question fired on no new prose
 * (H1-5). The two modules now answer "what is a word?" the same way by
 * construction, rather than with two definitions that happen to agree.
 */
export function countProseWords(raw: string): number {
  return (stripMarkdown(raw).match(WORD_RE) ?? []).length;
}


/**
 * Split prose into sentences at `.`/`!`/`?`, tolerating trailing closing
 * marks. Two things are NOT sentence ends: the dot of a known abbreviation
 * (`Mr. Darcy`), and a dot inside an ellipsis (`hall... then`). Both used to
 * manufacture extra sentences and skew every sentence-shape statistic.
 *
 * A quote only ends a sentence when it directly follows a terminator, so
 * possessives ("the writers' guild") and inline quotes never split one.
 */
function splitSentences(prose: string): string[] {
  const out: string[] = [];
  let start = 0;
  SENTENCE_BREAK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_BREAK_RE.exec(prose)) !== null) {
    const terminator = m[0][0];
    const at = m.index;
    if (terminator === '.') {
      // Inside an ellipsis: the run of dots is one mark, not a sentence end.
      if (prose[at - 1] === '.' || prose[at + 1] === '.') continue;
      if (ABBREVIATION_RE.test(prose.slice(start, at))) continue;
    }
    const piece = prose.slice(start, at + m[0].length).trim();
    if (piece.length > 0) out.push(piece);
    start = at + m[0].length;
  }
  const tail = prose.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
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

  // Adverb + hedge rate. Iterated over MATCHES, not the bare word list, so the
  // -ly test can see capitalization and what follows — the only evidence that
  // separates a proper noun from an adverb without a lexicon (H1-4).
  let adverbHedgeCount = 0;
  for (const m of prose.matchAll(WORD_RE)) {
    const w = m[0];
    const lower = w.toLowerCase();
    if (Object.hasOwn(HEDGES, lower)) {
      adverbHedgeCount++;
      continue;
    }
    if (w.length <= 3 || !lower.endsWith('ly')) continue;
    if (Object.hasOwn(NON_ADVERB_LY, lower)) continue;
    if (isCapitalized(w) && !isAdverbialSentenceOpener(prose, m.index, w)) continue;
    adverbHedgeCount++;
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
  // A suffix word counts only when its ending is a real suffix AND it sits in
  // noun position (H1-3); the bare spelling test made "moment" a nominalization.
  let previous = '';
  for (const m of prose.matchAll(WORD_RE)) {
    const lower = m[0].toLowerCase();
    const isNominal =
      NOMINAL_SUFFIX_RE.test(lower) &&
      !Object.hasOwn(STOPWORDS, lower) &&
      !Object.hasOwn(NOT_A_NOMINALIZATION, lower) &&
      Object.hasOwn(NOUN_INTRODUCER, previous);
    if (isNominal) nominalCount++;
    previous = lower;
  }
  for (const sentence of sentences) {
    const agent = PASSIVE_AGENT_RE.exec(sentence);
    if (agent && !Object.hasOwn(NOT_A_PARTICIPLE, agent[1].toLowerCase())) {
      nominalCount++;
      continue;
    }
    if (PASSIVE_PROGRESSIVE_RE.test(sentence)) nominalCount++;
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
