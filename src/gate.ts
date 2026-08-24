/**
 * The gate: decide whether a model output is ONE question and nothing else.
 *
 * The gate is deliberately syntactic — it cannot read intent — so it accepts
 * iff ALL of:
 *  - trimmed and non-empty, single line (no `\n`)
 *  - at most MAX_QUESTION_LENGTH characters
 *  - exactly one real question mark (`?` or fullwidth `？`), which must be
 *    the final character — a question mark inside paired quotation marks is
 *    quoted speech, not a second question
 *  - no sentence-terminal punctuation (`.`, `!`, `?`, `。`, `！`, `？`)
 *    before the final character UNLESS it is a question mark sitting inside
 *    a pair of quotation marks ("why?" is quoted speech, not a new sentence;
 *    a quoted `.`/`!` is NOT exempt — a quoted declarative sentence followed
 *    by a question is two sentences, which is the S1-0 rewrite pattern)
 *  - no list marker at the start (`-`, `*`, `•`, `+`, `—`, `–`, or
 *    `N.`/`N)`-style), checked after leading quotes/decor are stripped so
 *    `"1. …` / `**- …` wrappers cannot defeat the `^` anchor
 *  - no trailing non-whitespace after the final question mark
 *
 * It rejects, never rewrites. Outputs that fail go back to the model once,
 * then fall back to a topic probe (see reshape.ts).
 */
import { CURSOR_END, CURSOR_START } from '../web/text-window.js';

/**
 * Hard cap on a single-question output. A legitimate one-question sentence
 * rarely exceeds ~200 characters, so 280 is comfortably above any real
 * question while still cutting off a one-line ramble that happens to contain
 * no sentence-final punctuation (the S1-0 long-essay shape).
 */
const MAX_QUESTION_LENGTH = 280;

/** Sentence-final punctuation, ASCII plus fullwidth equivalents. */
const SENTENCE_TERMINAL: Record<string, true> = {
 '.': true, '!': true, '?': true, '。': true, '！': true, '？': true,
};

/** Quote characters that open a quoted region. */
const OPEN_QUOTE: Record<string, string> = {
 '"': '"',
 '\u2018': '\u2019', // ‘ ’
 '\u201c': '\u201d', // “ ”
 '\u00ab': '\u00bb', // « »
 '\u300c': '\u300d', // 「 」
 '\u300e': '\u300f', // 『 』
};
/** Quote characters that close a quoted region (map close -> its opener). */
const CLOSE_QUOTE: Record<string, string> = {
 '"': '"',
 '\u2019': '\u2018',
 '\u201d': '\u201c',
 '\u00bb': '\u00ab',
 '\u300d': '\u300c',
 '\u300f': '\u300e',
};

/** A straight `'` between two letters is an apostrophe, not a quote. */
function isApostrophe(s: string, i: number): boolean {
 return (
  i > 0 &&
  i + 1 < s.length &&
  /[A-Za-z\u00C0-\u024F]/.test(s[i - 1]) &&
  /[A-Za-z\u00C0-\u024F]/.test(s[i + 1])
 );
}

/**
 * For each index, whether the character sits inside a pair of quotation
 * marks (quoted speech) rather than in the surrounding prose.
 */
function quoteCoverage(s: string): boolean[] {
 const inQuote = new Array<boolean>(s.length).fill(false);
 const open: string[] = [];
 for (let i = 0; i < s.length; i++) {
  inQuote[i] = open.length > 0;
  const c = s[i];
  if (c === "'") {
   if (isApostrophe(s, i)) continue;
   if (open.length > 0 && open[open.length - 1] === "'") open.pop();
   else open.push("'");
   continue;
  }
  const closer = CLOSE_QUOTE[c];
  if (closer !== undefined) {
   if (open.length > 0 && open[open.length - 1] === closer) open.pop();
   else if (OPEN_QUOTE[c] !== undefined) open.push(OPEN_QUOTE[c]);
   continue;
  }
  const opener = OPEN_QUOTE[c];
  if (opener !== undefined) open.push(opener);
 }
 return inQuote;
}

/** Quote characters that may wrap a list marker ("1. …" inside `"` or «»). */
const QUOTE_CHARS: Record<string, true> = {
 '"': true, "'": true, '\u2018': true, '\u2019': true, '\u201c': true,
 '\u201d': true, '\u00ab': true, '\u00bb': true, '\u300c': true,
 '\u300d': true, '\u300e': true, '\u300f': true,
};

/**
 * Strip leading decor so the `^`-anchored list check cannot be defeated by
 * a wrapper: quotes (`"1. …`), markdown bold (`**- …`), or whitespace
 * (`\t- …`). A bare `*`/`_` immediately followed by a space is a BULLET, not
 * decor, so it survives and trips the list check itself.
 */
function stripLeadingDecor(t: string): string {
 let i = 0;
 while (i < t.length) {
  const c = t[i];
  if (/\s/.test(c) || QUOTE_CHARS[c] === true) {
   i++;
   continue;
  }
  if ((c === '*' || c === '_') && !/\s/.test(t[i + 1] ?? '')) {
   i++;
   continue;
  }
  break;
 }
 return t.slice(i);
}

export function isSingleQuestion(s: string): boolean {
 const t = s.trim();
 if (t.length === 0) return false;
 if (t.length > MAX_QUESTION_LENGTH) return false;
 if (t.includes('\n')) return false;

 const u = stripLeadingDecor(t);
 if (/^(?:[-*•+—–]|\d+[.)])/.test(u)) return false;

 const last = t[t.length - 1];
 if (last !== '?' && last !== '？') return false;

 const inQuote = quoteCoverage(t);
 for (let i = 0; i < t.length - 1; i++) {
  const c = t[i];
  if (SENTENCE_TERMINAL[c] !== true) continue;
  if (inQuote[i] && (c === '?' || c === '？')) continue; // quoted question = speech
  return false; // any other sentence-final punctuation before the end
 }
 return true;
}

/**
 * Remove the transport's cursor-marker tokens from model output. The model
 * sometimes quotes the literal `[CURSOR START]` / `[CURSOR END]` tokens when
 * grounding in the marked region; they are our plumbing, never the writer's
 * words, so decode precedes every gate predicate (see reshape.tryComplete).
 */
export function stripCursorMarkers(output: string): string {
 return output.split(CURSOR_START).join('').split(CURSOR_END).join('');
}

/**
 * The grounding gate: reject model output that never touches the writer's
 * text, that merely echoes the text back as a question, or that dumps the
 * seed verbatim. The three predicates below are pure and deterministic.
 */

/**
 * Words that carry no topical content. A token in this table can never anchor
 * a grounding match, an echo, or a seed copy.
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

/** Lowercase alphanumeric tokens of length >= 3 that are not stopwords. */
function contentWords(s: string): Set<string> {
 const words = new Set<string>();
 for (const token of s.toLowerCase().split(/[^a-z0-9]+/)) {
  if (token.length < 3) continue;
  if (STOPWORDS[token] === true) continue;
  words.add(token);
 }
 return words;
}

/** Adjacent-word bigrams, lowercased with punctuation stripped. */
function wordBigrams(s: string): string[] {
 const tokens = s
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter((t) => t.length > 0);
 const bigrams: string[] = [];
 for (let i = 0; i + 1 < tokens.length; i++) {
  bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
 }
 return bigrams;
}

/**
 * True iff the question shares at least one content word with the text
 * window, where a shared word is a full-word match or a morphological
 * prefix ("walk" ↔ "walked", "store" ↔ "storekeeper"). Requiring the
 * shorter word to be a PREFIX of the longer one — the overlap touching the
 * left word boundary of the longer word — keeps genuine stem matches while
 * rejecting accidental substring overlap in the middle or on the right
 * ("time" inside "sometimes", "ring" inside "bring"/"during"). The 4-char
 * floor means a short token never matches inside a longer one at all
 * ("her" never matches inside "where", but "other" is a stopword anyway).
 * An empty question or window is never grounded.
 */
export function isGrounded(question: string, textWindow: string): boolean {
 const questionWords = contentWords(question);
 const windowWords = contentWords(textWindow);
 if (questionWords.size === 0 || windowWords.size === 0) return false;
 for (const q of questionWords) {
  for (const w of windowWords) {
   if (Math.min(q.length, w.length) < 4) continue;
   const [shorter, longer] = q.length <= w.length ? [q, w] : [w, q];
   if (longer.startsWith(shorter)) return true;
  }
 }
 return false;
}

/**
 * True iff more than half of the question's adjacent-word bigrams appear as
 * contiguous bigrams in the window's token stream. Catches the model
 * restating the passage back as a question.
 *
 * Retargeting: the window is normally the whole draft, with `[CURSOR START]` /
 * `[CURSOR END]` markers embedded around the cursor's block (see
 * web/text-window.ts). When both markers are present, the check runs against
 * the cursor envelope — the marked block plus one blank-line-separated block
 * on each side, markers stripped — instead of the whole draft. A full-draft
 * window would dilute one short marked paragraph's bigrams against all the
 * surrounding text, so a restatement of exactly the passage under the cursor
 * could slip under the 50% threshold and never fire the echo check; the
 * envelope keeps the check where the writer is looking. Marker-less windows
 * (the legacy shape) keep the whole-window behavior.
 */
export function echoesText(question: string, textWindow: string): boolean {
 const questionBigrams = wordBigrams(question);
 if (questionBigrams.length === 0) return false;
 const windowBigrams = new Set(wordBigrams(cursorEnvelope(textWindow)));
 let shared = 0;
 for (const b of questionBigrams) {
  if (windowBigrams.has(b)) shared++;
 }
 return shared / questionBigrams.length > 0.5;
}

/**
 * The text the echo check tests against: the cursor envelope when the window
 * carries `[CURSOR START]` / `[CURSOR END]` markers, else the whole window.
 * The envelope is the marked block plus one blank-line-separated block on
 * each side, with the markers stripped.
 */
function cursorEnvelope(textWindow: string): string {
 const startMarker = textWindow.indexOf(CURSOR_START);
 const endMarker = textWindow.indexOf(CURSOR_END);
 if (startMarker === -1 || endMarker === -1 || endMarker < startMarker) {
  return textWindow;
 }
 const blocks = textWindow.split(/\n\s*\n/);
 const marked = blocks.findIndex((b) => b.includes(CURSOR_START));
 if (marked === -1) return textWindow;
 return blocks
  .slice(Math.max(0, marked - 1), marked + 2)
  .join('\n\n')
  .split(CURSOR_START)
  .join('')
  .split(CURSOR_END)
  .join('');
}

/**
 * True iff more than half of the question's content words appear, exactly,
 * among the seed's content words. Catches near-verbatim seed dumps.
 */
export function copiesSeed(question: string, seed: string): boolean {
 const questionWords = contentWords(question);
 const seedWords = contentWords(seed);
 if (questionWords.size === 0) return false;
 let shared = 0;
 for (const q of questionWords) {
  if (seedWords.has(q)) shared++;
 }
 return shared / questionWords.size > 0.5;
}
