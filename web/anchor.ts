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
 * Anchor policy (in priority order):
 *   1. LONGEST fragment fully inside the cursor envelope (the cursor block
 *      plus one block on each side, never crossing a heading),
 *   2. NEAREST fragment to cursorOffset (min |fragment.start - cursorOffset|),
 *   3. LONGEST fragment anywhere.
 * Ties at any tier break toward the first occurrence in the draft. Returns
 * null when no distinctive question word appears in the draft at all.
 */

import { splitBlocks } from './text-window.js';

export interface Anchor {
  /** character offset of the anchor's first character in the draft */
  start: number;
  /** character offset just past the anchor's last character */
  end: number;
  /** the matched draft text, i.e. draft.slice(start, end) */
  fragment: string;
}

/** A draft word token with its character range in the draft. */
interface Token {
  /** the word, lowercased */
  word: string;
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
}

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
 * A word: a run of letters/numbers, optionally with internal apostrophes
 * (so "don't" stays one token, "mid-word" splits into two).
 */
const WORD_RE = /[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu;

/** Split text into lowercased word tokens with draft character offsets. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(WORD_RE)) {
    tokens.push({ word: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
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
        const start = startToken.start + startToken.word.indexOf(sub[0]);
        const end = endToken.start + endToken.word.indexOf(sub[len - 1]) + sub[len - 1].length;
        candidates.push({ start, end, span: end - start });
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

function toAnchor(draft: string, candidate: Candidate): Anchor {
  return { start: candidate.start, end: candidate.end, fragment: draft.slice(candidate.start, candidate.end) };
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
  if (candidates.length === 0) return null;
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
    let bestDist = Infinity;
    for (let j = i + 3; j < question.length; j++) {
      const close = question[j];
      if (!QUOTE_MARKS.test(close)) continue;
      if ((close === "'" || close === '\u2019') && isLetter(question[j - 1]) && isLetter(question[j + 1])) continue;
      const inner = question.slice(i + 1, j).trim();
      if (inner.split(/\s+/).filter(Boolean).length < 2) continue; // too short — keep scanning outward
      // Find EVERY occurrence and keep the closest to the cursor: repeated
      // paragraphs (or identical filler windows) make the first occurrence
      // global-first, which can sit in an entirely different window.
      const needle = inner.toLowerCase();
      const positions: number[] = [];
      let pos = lowerDraft.indexOf(needle);
      while (pos !== -1) {
        positions.push(pos);
        pos = lowerDraft.indexOf(needle, pos + 1);
      }
      // Prefer the occurrence closest to the cursor so repeated paragraphs
      // anchor to THIS window, not an earlier twin of the same text.
      for (const p of positions) {
        const dist = Math.abs(p - cursorOffset);
        if (bestForThisOpen === null || dist < bestDist || (dist === bestDist && p < bestForThisOpen.start)) {
          bestForThisOpen = { start: p, end: p + needle.length, span: needle.length };
          bestDist = dist;
        }
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
    };
  }


  const blocks = splitBlocks(draft);
  const envelope = blocks.length > 0 ? cursorEnvelope(blocks, cursorBlockIndex(blocks, cursorOffset)) : null;

  // 1. Longest fragment fully inside the cursor envelope.
  if (envelope) {
    let best: Candidate | null = null;
    for (const c of candidates) {
      if (c.start < envelope.start || c.end > envelope.end) continue;
      if (best === null || c.span > best.span || (c.span === best.span && c.start < best.start)) best = c;
    }
    if (best) return toAnchor(draft, best);
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
  if (nearest) return toAnchor(draft, nearest);

  // 3. Longest fragment anywhere (reached only when no fragment exists).
  let longest: Candidate | null = null;
  for (const c of candidates) {
    if (longest === null || c.span > longest.span || (c.span === longest.span && c.start < longest.start)) {
      longest = c;
    }
  }
  return longest ? toAnchor(draft, longest) : null;
}
