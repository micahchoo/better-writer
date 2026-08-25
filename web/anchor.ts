/**
 * anchor: the pure client-side module that finds the span of the writer's
 * draft a coach question is about. The server never returns an anchor — the
 * model answers with a bare question, and this module pins that question to
 * the exact draft text it refers to by matching the question's distinctive
 * words against the draft.
 *
 * Fragment = a contiguous run of >= 1 DISTINCTIVE question word (length >= 3,
 * not a stopword) that appears in the draft as a contiguous word sequence.
 * Matching is case-insensitive; whitespace runs collapse; punctuation never
 * enters a fragment; a question word may match mid-word inside a draft word
 * ("canny" matches inside "uncanny"), so fragments may start or end inside a
 * draft word only where the word itself is matched.
 *
 * Anchor policy, applied in two passes. Candidates are ranked by QUALITY —
 * a multi-word phrase, then a lone word that is long and non-generic, then a
 * short or generic lone word — and the pass below runs over the strong tiers
 * first, over everything only if they are empty:
 *   1. LONGEST fragment fully inside the cursor envelope (the cursor block
 *      plus one block on each side, never crossing a heading),
 *   2. NEAREST fragment to cursorOffset (min |fragment.start - cursorOffset|),
 *   3. LONGEST fragment anywhere.
 * Ties at any tier break toward the first occurrence in the draft. Returns
 * null when no distinctive question word appears in the draft at all.
 *
 * The winner is then WIDENED if it is a lone word: the anchor becomes the
 * sentence containing that word, clipped to its own block and capped at
 * MAX_ANCHOR_CHARS. So the span the writer sees highlighted is always a
 * phrase or a sentence — never one bare word — while the reach of the
 * matching stays what it was. See toAnchor for why both halves are needed.
 */

import { splitBlocks } from './text-window.js';

export interface Anchor {
  /** character offset of the anchor's first character in the draft */
  start: number;
  /** character offset just past the anchor's last character */
  end: number;
  /** the anchored draft text, i.e. draft.slice(start, end) */
  fragment: string;
  /**
   * The span the question's own words matched, always inside [start, end).
   * Equal to the anchor for a phrase match; narrower when a lone word was
   * widened to its sentence (see toAnchor). Kept so a consumer can mark the
   * matched word inside the highlighted sentence, and so the matching rules
   * stay observable now that the anchor is no longer the raw match.
   */
  match: { start: number; end: number };
}

/** A draft word token with its character range in the draft. */
interface Token {
  /** the word, lowercased — the comparison form, never a source of offsets */
  word: string;
  /**
   * Draft offset for each index of `word`, plus one final entry for its end.
   * Lowercasing is NOT length-preserving — Turkish `İ` (U+0130) lowercases to
   * two code units — so an index into `word` cannot be added to `start` to get
   * a draft offset. It produced anchors that leaked whitespace, started inside
   * the wrong token, and could end past the end of the document (H3-1). Every
   * offset derived from a comparison index goes through this map.
   */
  offsets: number[];
  /** offset of the word's first character in the draft */
  start: number;
  /** offset just past the word's last character */
  end: number;
}

/** A candidate fragment: a matched word sequence's character range. */
interface Candidate {
  start: number;
  end: number;
  span: number;
  /** how many question words the match consumed; 1 means a lone word */
  words: number;
  /** Quality tier — see QUALITY_*. Selection prefers the highest available. */
  quality: number;
}

/** A multi-word match: a content phrase, always the best anchor available. */
const QUALITY_PHRASE = 2;
/** A lone word that is long enough and not generic — a usable anchor. */
const QUALITY_DISTINCTIVE = 1;
/** A lone word that is short or generic — used only when nothing else matched. */
const QUALITY_WEAK = 0;

/** The structural slice of a text-window block the anchor module consumes. */
interface BlockLike {
  text: string;
  start: number;
  end: number;
  kind: string;
}

/** Draft n-grams are indexed up to this many words. */
const MAX_NGRAM = 8;

/**
 * Words that carry no topical content. A token in this table can never be a
 * fragment word.
 *
 * NOTE: duplicated verbatim from src/gate.ts's STOPWORDS, which owns the
 * canonical list. The duplication is accepted by design so this pure client
 * module stays free of server imports; keep the two tables in sync.
 */
const STOPWORDS: Record<string, true> = {
  the: true, a: true, an: true, and: true, or: true, but: true, of: true,
  in: true, on: true, at: true, to: true, for: true, with: true, from: true,
  by: true, as: true, is: true, are: true, was: true, were: true, be: true,
  been: true, being: true, this: true, that: true, these: true, those: true,
  it: true, its: true, your: true, you: true, my: true, i: true, me: true,
  we: true, our: true, they: true, their: true, he: true, she: true,
  him: true, her: true, his: true, them: true, if: true, so: true, such: true,
  not: true, no: true, yes: true, do: true, does: true, did: true,
  have: true, has: true, had: true, will: true, would: true, can: true,
  could: true, should: true, may: true, might: true, must: true, about: true,
  into: true, over: true, under: true, again: true, then: true, once: true,
  here: true, there: true, when: true, where: true, why: true, how: true,
  what: true, who: true, which: true, while: true, after: true, before: true,
  until: true, because: true, than: true, too: true, very: true, just: true,
  also: true, only: true, own: true, same: true, other: true, said: true,
  say: true, says: true, out: true, up: true, down: true, off: true,
  through: true, all: true, any: true, each: true, more: true, most: true,
  some: true, few: true, both: true, between: true, among: true,
  without: true, within: true, across: true, behind: true, beyond: true,
  above: true, below: true, near: true, far: true, long: true, short: true,
  much: true, many: true,
};
/**
 * Minimum character length for a SINGLE-word fragment to be a valid anchor.
 * Fragments of two or more words are always distinctive (a content phrase);
 * a lone word shorter than this carries too little signal to pin the
 * question to the draft. Calibrated so short content words still anchor
 * ("milk", "ocean") while sub-word junk ("one", "let") and substring stubs
 * ("ill" out of "still") fall out.
 */
const MIN_FRAGMENT_CHARS = 4;

/**
 * Low-distinctiveness words that cannot be the SOLE word of a fragment.
 * These are high-frequency generic English words (ordinals, numerals,
 * generic verbs/nouns) that carry little topical content on their own, so a
 * lone one of them is a junk anchor ("first", "one", "time"). A generic
 * word is still allowed inside a MULTI-word fragment ("first draft") and is
 * never removed from the distinctive-word stream — only barred from being a
 * lone anchor.
 *
 * This is NOT the gate-synced STOPWORDS table above (which decides whether a
 * word enters the distinctive stream at all); it is an anchoring-only
 * quality floor calibrated against the bundled sample draft. Keep it lean
 * and domain-neutral: do not add draft-specific content words ("paste",
 * "water") or craft terms ("scene", "character") that can be genuine anchors.
 */
const GENERIC_WORDS: Record<string, true> = {
  // ordinals / numerals / quantifiers
  first: true, second: true, third: true, last: true, next: true,
  one: true, two: true, three: true, ten: true, single: true,
  // time and sequence
  time: true, times: true, day: true, days: true, year: true, years: true,
  moment: true, moments: true, hour: true, hours: true, week: true,
  weeks: true, month: true, months: true, morning: true, night: true,
  // generic verbs
  let: true, use: true, make: true, made: true, get: true, got: true,
  take: true, took: true, give: true, gave: true, come: true, came: true,
  go: true, went: true, look: true, looked: true, know: true, knew: true,
  think: true, thought: true, want: true, wanted: true, need: true,
  needed: true, feel: true, felt: true, find: true, found: true, keep: true,
  kept: true, put: true, mean: true, meant: true, see: true, saw: true,
  move: true, moved: true, turn: true, turned: true, read: true, work: true,
  stop: true, follow: true, show: true, try: true, trying: true,
  // generic nouns
  thing: true, things: true, way: true, ways: true, part: true, parts: true,
  point: true, points: true, kind: true, kinds: true, sort: true, end: true,
  back: true, life: true, word: true, words: true, line: true, lines: true,
  voice: true, set: true, stuff: true, nothing: true, everything: true,
  // function-ish / weak adjectives & adverbs
  still: true, never: true, always: true, now: true, against: true,
  together: true, itself: true, self: true, real: true, hard: true, old: true,
  new: true, good: true, big: true, small: true, little: true, sure: true,
  right: true, great: true, really: true, often: true, sometimes: true,
  maybe: true, finally: true, whole: true, simple: true, specific: true,
  actual: true, different: true, other: true,
};

/**
 * A word: a run of letters/numbers, optionally with internal apostrophes
 * (so "don't" stays one token, "mid-word" splits into two).
 */
const WORD_RE = /[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu;

/** Split text into lowercased word tokens with draft character offsets. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(WORD_RE)) {
    const raw = match[0];
    const start = match.index;
    // Lower one code point at a time, recording where each produced character
    // came from, so a comparison index maps back to an exact draft offset.
    // A fold that expands (İ -> i + combining dot) maps every character it
    // produced to the start of the code point that produced it.
    let word = '';
    const offsets: number[] = [];
    let rawOffset = start;
    for (const cp of raw) {
      const lowered = cp.toLowerCase();
      for (let k = 0; k < lowered.length; k++) offsets.push(rawOffset);
      word += lowered;
      rawOffset += cp.length;
    }
    offsets.push(start + raw.length); // end sentinel
    tokens.push({ word, offsets, start, end: start + raw.length });
  }
  return tokens;
}

/** The question's distinctive words in question order (duplicates kept). */
function distinctiveWords(question: string): string[] {
  const words: string[] = [];
  for (const match of question.matchAll(WORD_RE)) {
    const word = match[0].toLowerCase();
    if (word.length < 3) continue;
    if (STOPWORDS[word] === true) continue;
    words.push(word);
  }
  return words;
}

/** For each distinctive question word, the draft tokens containing it. */
function buildContainsMap(tokens: Token[], qWords: string[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const q of new Set(qWords)) {
    const list: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].word.includes(q)) list.push(i);
    }
    if (list.length > 0) map.set(q, list);
  }
  return map;
}

/**
 * Draft n-gram index: every contiguous run of 1..MAX_NGRAM draft words,
 * lowercased and joined with single spaces, mapped to its starting token
 * indices. Built once per call.
 */
function buildNgramIndex(tokens: Token[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i < tokens.length; i++) {
    let key = tokens[i].word;
    addToIndex(index, key, i);
    for (let n = 2; n <= MAX_NGRAM && i + n <= tokens.length; n++) {
      key += ' ' + tokens[i + n - 1].word;
      addToIndex(index, key, i);
    }
  }
  return index;
}

function addToIndex(index: Map<string, number[]>, key: string, position: number): void {
  const list = index.get(key);
  if (list) list.push(position);
  else index.set(key, [position]);
}

/**
 * Every place a question word run occurs in the draft, as a candidate
 * fragment. Exact n-gram hits come from the index; substring hits (a
 * question word found inside a longer draft word) come from the containment
 * map. The containment pass subsumes the exact hits, so the two are unioned
 * and deduplicated.
 */
function findCandidates(
  tokens: Token[],
  qWords: string[],
  contains: Map<string, number[]>,
  ngrams: Map<string, number[]>,
): Candidate[] {
  const candidates: Candidate[] = [];
  const maxLen = Math.min(MAX_NGRAM, qWords.length);
  for (let len = 1; len <= maxLen; len++) {
    for (let j = 0; j + len <= qWords.length; j++) {
      const sub = qWords.slice(j, j + len);
      const positions = new Set<number>();

      const exact = ngrams.get(sub.join(' '));
      if (exact) for (const p of exact) positions.add(p);

      const first = contains.get(sub[0]);
      if (first) {
        for (const p of first) {
          let ok = true;
          for (let k = 1; k < len; k++) {
            const token = tokens[p + k];
            if (!token || !token.word.includes(sub[k])) {
              ok = false;
              break;
            }
          }
          if (ok) positions.add(p);
        }
      }

      for (const p of positions) {
        const startToken = tokens[p];
        const endToken = tokens[p + len - 1];
        // Both offsets come from the token's own index map, never from
        // `start + index`: lowercasing can change length (H3-1).
        const start = startToken.offsets[startToken.word.indexOf(sub[0])];
        // A fragment must never end mid-word (first-hunt #14): the end is
        // ALWAYS the containing token's own boundary, whether or not the
        // matched question-word consumed the token fully ("walk" inside
        // "walkings" ends at "walkings"). For a doubled token ("catcat") the
        // start takes the first occurrence, so extending to the full token
        // keeps that pairing coherent.
        const end = endToken.end;
        // Anchor quality is RANKED here, never used to discard. A multi-word
        // fragment is a content phrase and always best; a lone word that is
        // long enough and not generic is usable; a short or generic lone word
        // is the last resort.
        //
        // Discarding the last resort is what the first attempt at this did,
        // and it cut the share of questions that anchored at all from 60% to
        // 17% — an un-anchored question is dropped, so the writer got nothing
        // instead of getting something weak (R1). Ranking keeps the reach and
        // still steers selection toward the better match.
        const quality =
          len > 1
            ? QUALITY_PHRASE
            : STOPWORDS[sub[0]] === true ||
                GENERIC_WORDS[sub[0]] === true ||
                end - start < MIN_FRAGMENT_CHARS
              ? QUALITY_WEAK
              : QUALITY_DISTINCTIVE;
        candidates.push({ start, end, span: end - start, words: len, quality });
      }
    }
  }
  return candidates;
}

/**
 * The block the cursor belongs to, mirroring text-window's own rule: a cursor
 * at a block's end (inclusive) belongs to that block; a cursor in a gap
 * belongs to the next block; a cursor past the last block belongs to the
 * last block.
 */
function cursorBlockIndex(blocks: BlockLike[], offset: number): number {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (offset >= b.start && offset <= b.end) return i;
  }
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].start >= offset) return i;
  }
  return blocks.length - 1;
}

/**
 * The cursor envelope: the cursor block plus one block on each side, never
 * crossing a heading (the same shape the server's gate sees in the marked
 * text window).
 */
function cursorEnvelope(blocks: BlockLike[], index: number): { start: number; end: number } {
  const block = blocks[index];
  const before = index > 0 && blocks[index - 1].kind !== 'heading' ? blocks[index - 1] : null;
  const after = index + 1 < blocks.length && blocks[index + 1].kind !== 'heading' ? blocks[index + 1] : null;
  return { start: before ? before.start : block.start, end: after ? after.end : block.end };
}

/**
 * Longest span a widened anchor may cover. A sentence longer than this is a
 * run-on; highlighting all of it would swamp the draft, so the widening falls
 * back to a bounded window centred on the matched word.
 */
const MAX_ANCHOR_CHARS = 200;

const SENTENCE_END = /[.!?]/;
const CLOSING_MARK = /["'”’)\]]/;

/**
 * The sentence containing `candidate`, clipped to `lo`..`hi` (its own block, so
 * a widened anchor can never cross a heading or reach into a neighbouring
 * paragraph).
 */
function sentenceSpan(
  draft: string,
  candidate: Candidate,
  lo: number,
  hi: number,
): { start: number; end: number } {
  let start = candidate.start;
  while (start > lo && !SENTENCE_END.test(draft[start - 1])) start--;
  // Step past the terminator's own closing marks and the space after it.
  while (start < candidate.start && (/\s/.test(draft[start]) || CLOSING_MARK.test(draft[start]))) start++;
  let end = candidate.end;
  while (end < hi && !SENTENCE_END.test(draft[end - 1])) end++;
  while (end < hi && CLOSING_MARK.test(draft[end])) end++;
  while (end > candidate.end && /\s/.test(draft[end - 1])) end--;
  return { start, end };
}

/**
 * A window of at most MAX_ANCHOR_CHARS around `candidate`, snapped outward-in
 * to whitespace so it never begins or ends mid-word.
 */
function boundedWindow(
  draft: string,
  candidate: Candidate,
  lo: number,
  hi: number,
): { start: number; end: number } {
  const slack = Math.max(0, MAX_ANCHOR_CHARS - candidate.span);
  let start = Math.max(lo, candidate.start - Math.floor(slack / 2));
  let end = Math.min(hi, start + MAX_ANCHOR_CHARS);
  while (start > lo && start < candidate.start && /\S/.test(draft[start - 1])) start++;
  while (end < hi && end > candidate.end && /\S/.test(draft[end])) end--;
  while (start < candidate.start && /\s/.test(draft[start])) start++;
  while (end > candidate.end && /\s/.test(draft[end - 1])) end--;
  return { start, end };
}

/**
 * Turn the winning candidate into the anchor the writer sees.
 *
 * A multi-word match is already a phrase and is returned as matched. A LONE
 * WORD is widened to the sentence that contains it, because a question pinned
 * to one bare word tells the writer nothing — "why does the rhythm change
 * here?" highlighted over `sound` is noise, over the sentence holding `sound`
 * it is a craft note. This is the whole of S2-7: the recorded defect was that
 * the demo pins questions to single, meaningless words, and a floor that
 * filtered those words out only stopped it from pinning at all (R1). Widening
 * removes single-word anchors by construction rather than by suppression.
 *
 * Widening never leaves the candidate's own block, and never exceeds
 * MAX_ANCHOR_CHARS.
 */
function toAnchor(draft: string, candidate: Candidate, blocks: BlockLike[]): Anchor {
  let { start, end } = candidate;
  if (candidate.words === 1) {
    const block = blocks.find((b) => candidate.start >= b.start && candidate.end <= b.end);
    const lo = block ? block.start : 0;
    const hi = block ? block.end : draft.length;
    const sentence = sentenceSpan(draft, candidate, lo, hi);
    const widened =
      sentence.end - sentence.start > MAX_ANCHOR_CHARS
        ? boundedWindow(draft, candidate, lo, hi)
        : sentence;
    // Never widen to LESS than the match itself.
    start = Math.min(widened.start, candidate.start);
    end = Math.max(widened.end, candidate.end);
  }
  return {
    start,
    end,
    fragment: draft.slice(start, end),
    match: { start: candidate.start, end: candidate.end },
  };
}

/**
 * Apply the three-tier anchor policy (envelope / nearest / longest) to one
 * candidate set. Returns null when the set is empty.
 */
function selectCandidate(
  candidates: Candidate[],
  envelope: { start: number; end: number } | null,
  cursorOffset: number,
): Candidate | null {
  if (candidates.length === 0) return null;

  // 1. Longest fragment fully inside the cursor envelope.
  if (envelope) {
    let best: Candidate | null = null;
    for (const c of candidates) {
      if (c.start < envelope.start || c.end > envelope.end) continue;
      if (best === null || c.span > best.span || (c.span === best.span && c.start < best.start)) best = c;
    }
    if (best) return best;
  }

  // 2. Nearest fragment to the cursor; ties break to the first occurrence.
  let nearest: Candidate | null = null;
  let nearestDist = Infinity;
  for (const c of candidates) {
    const dist = Math.abs(c.start - cursorOffset);
    if (nearest === null || dist < nearestDist || (dist === nearestDist && c.start < nearest.start)) {
      nearest = c;
      nearestDist = dist;
    }
  }
  if (nearest) return nearest;

  // 3. Longest fragment anywhere (unreachable while the set is non-empty).
  let longest: Candidate | null = null;
  for (const c of candidates) {
    if (longest === null || c.span > longest.span || (c.span === longest.span && c.start < longest.start)) {
      longest = c;
    }
  }
  return longest;
}

/**
 * Find the draft span a question is about, per the anchor policy above.
 *
 * @param question the coach's question (the model's answer)
 * @param draft the full draft markdown
 * @param cursorOffset character offset of the cursor in the draft
 * @returns the anchor, or null when no distinctive question word appears in
 *   the draft
 */
export function extractAnchor(question: string, draft: string, cursorOffset: number): Anchor | null {
  const tokens = tokenize(draft);
  if (tokens.length === 0) return null;

  const qWords = distinctiveWords(question);
  if (qWords.length === 0) return null;

  const contains = buildContainsMap(tokens, qWords);
  const ngrams = buildNgramIndex(tokens);
  const candidates = findCandidates(tokens, qWords, contains, ngrams);
  // Tier 0 — VERBATIM QUOTES. The question may quote the text directly
  // ("Never meet your heroes"). A quoted span is the strongest possible
  // signal of what the question is about: it outranks the cursor envelope,
  // because the model deliberately named those words wherever they sit.
  //
  // Matching is RAW SUBSTRING on the lowercased draft — NOT the n-gram
  // index. The index is keyed by raw tokens (stopwords included) while
  // distinctiveWords() strips them, so index lookups miss every quote that
  // contains a stopword ("never meet YOUR heroes"). Substring search also
  // matches quotes that span punctuation exactly as written.
  //
  // Quote-mark rules: apostrophes only OPEN a quote when not flanked by
  // letters (contractions like "don't" are word characters, not quotes),
  // and the inner scan keeps extending past each successful closing mark,
  // keeping the longest match for this opening quote — so an apostrophe
  // inside the quoted text ("the writer's words") can't truncate it.
  const QUOTE_MARKS = /["\u201C\u201D'’]/;
  const isLetter = (ch: string | undefined) => ch !== undefined && /[A-Za-z\u00C0-\u024F]/.test(ch);
  let bestQuote = null;
  const lowerDraft = draft.toLowerCase();
  for (let i = 0; i < question.length; i++) {
    const open = question[i];
    if (!QUOTE_MARKS.test(open)) continue;
    if ((open === "'" || open === '\u2019') && (isLetter(question[i - 1]) || isLetter(question[i + 1]))) continue;

    let bestForThisOpen: { start: number; end: number; span: number } | null = null;
    for (let j = i + 3; j < question.length; j++) {
      const close = question[j];
      if (!QUOTE_MARKS.test(close)) continue;
      if ((close === "'" || close === '\u2019') && isLetter(question[j - 1]) && isLetter(question[j + 1])) continue;
      const inner = question.slice(i + 1, j).trim();
      if (inner.split(/\s+/).filter(Boolean).length < 2) continue; // too short — keep scanning outward
      // For this closing candidate, find EVERY occurrence and keep the
      // closest to the cursor: repeated paragraphs (or identical filler
      // windows) make the first occurrence global-first, which can sit in
      // an entirely different window.
      const needle = inner.toLowerCase();
      let bestForNeedle: { start: number; end: number; span: number } | null = null;
      let bestDist = Infinity;
      let pos = lowerDraft.indexOf(needle);
      while (pos !== -1) {
        const dist = Math.abs(pos - cursorOffset);
        if (bestForNeedle === null || dist < bestDist || (dist === bestDist && pos < bestForNeedle.start)) {
          bestForNeedle = { start: pos, end: pos + needle.length, span: needle.length };
          bestDist = dist;
        }
        pos = lowerDraft.indexOf(needle, pos + 1);
      }
      if (!bestForNeedle) continue;
      // Among the closing candidates for this opening mark, keep the LONGEST
      // span — the inner scan extends past each successful closing mark — so
      // an apostrophe inside the quoted text ("the writer's words") can't
      // truncate it. Ties break toward the earlier start in the draft.
      if (
        bestForThisOpen === null ||
        bestForNeedle.span > bestForThisOpen.span ||
        (bestForNeedle.span === bestForThisOpen.span && bestForNeedle.start < bestForThisOpen.start)
      ) {
        bestForThisOpen = bestForNeedle;
      }
    }
    if (bestForThisOpen && (bestQuote === null || bestForThisOpen.span > bestQuote.span)) {
      bestQuote = bestForThisOpen;
    }
  }
  if (bestQuote) {
    return {
      start: bestQuote.start,
      end: bestQuote.end,
      fragment: draft.slice(bestQuote.start, bestQuote.end),
      match: { start: bestQuote.start, end: bestQuote.end },
    };
  }
  if (candidates.length === 0) return null;


  const blocks = splitBlocks(draft);
  const envelope = blocks.length > 0 ? cursorEnvelope(blocks, cursorBlockIndex(blocks, cursorOffset)) : null;

  // Quality first, then the three-tier policy WITHIN that quality. A phrase or
  // a distinctive word anywhere beats a generic word next to the cursor; only
  // when neither exists does the weak set get its turn.
  const strong = candidates.filter((c) => c.quality > QUALITY_WEAK);
  const winner =
    selectCandidate(strong, envelope, cursorOffset) ??
    selectCandidate(candidates, envelope, cursorOffset);
  return winner ? toAnchor(draft, winner, blocks) : null;
}
