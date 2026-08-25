/**
 * The gate: decide whether a model output is ONE question and nothing else.
 *
 * The gate is deliberately syntactic — it cannot read intent — so it accepts
 * iff ALL of:
 *  - trimmed and non-empty, single line (no `\n`)
 *  - at most MAX_QUESTION_LENGTH characters
 *  - it ends in a terminal CLUSTER of `?`/`!` (either width) containing at
 *    least one question mark, so "Why?!" is one question and "Really!" is
 *    not one at all
 *  - no sentence-terminal punctuation (`.`, `!`, `?`, `。`, `！`, `？`)
 *    before that cluster, with two exemptions: a question mark sitting
 *    inside a pair of quotation marks ("why?" is quoted speech, not a new
 *    sentence — a quoted `.`/`!` is NOT exempt, since a quoted declarative
 *    followed by a question is two sentences, the S1-0 rewrite pattern), and
 *    a `.` that belongs to a word or a number rather than to a sentence
 *    ("Dr. Smith", "3.5", "e.g.")
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

/**
 * Abbreviations whose dot is not a sentence end. Rejecting them made the gate
 * fail genuine one-sentence questions ("Is Dr. Smith coming?"), which spends
 * the single retry and hands the writer a fixed topic probe instead (H2-1).
 */
const GATE_ABBREVIATIONS: Record<string, true> = {
 mr: true, mrs: true, ms: true, mx: true, dr: true, prof: true, rev: true,
 hon: true, st: true, mt: true, sr: true, jr: true, lt: true, sgt: true,
 capt: true, gen: true, col: true, gov: true, pres: true, vs: true, cf: true,
 al: true, eg: true, ie: true, fig: true, vol: true, ch: true, pp: true,
 approx: true, dept: true,
};
// "etc" and "no" are deliberately absent: both routinely DO end a sentence
// ("She said no."), so exempting their dot would let two sentences through.

/**
 * True when the `.` at `i` is part of a word or a number rather than the end
 * of a sentence: a decimal point (3.5), an internal dot (e.g., i.e.), or the
 * dot of a known abbreviation.
 */
function isNonTerminalDot(t: string, i: number): boolean {
 const prev = t[i - 1];
 const next = t[i + 1];
 if (prev !== undefined && next !== undefined) {
  if (/[0-9]/.test(prev) && /[0-9]/.test(next)) return true;
  // No space after the dot and letters on both sides: inside a word, never
  // a sentence boundary ("e.g.", "i.e.", "u.s.").
  if (/[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next)) return true;
 }
 // Walk back over letters AND internal dots, so a dotted abbreviation is read
 // whole ("e.g." -> "eg") rather than as its last letter ("g").
 let j = i - 1;
 while (j >= 0 && /[A-Za-z.]/.test(t[j])) j--;
 const word = t.slice(j + 1, i).replace(/\./g, '').toLowerCase();
 return GATE_ABBREVIATIONS[word] === true;
}

/** `?` and `!` in both widths — the characters a terminal cluster may hold. */
const CLUSTER_MARK: Record<string, true> = {
 '?': true, '!': true, '？': true, '！': true,
};
const QUESTION_MARK: Record<string, true> = { '?': true, '？': true };

export function isSingleQuestion(s: string): boolean {
 const t = s.trim();
 if (t.length === 0) return false;
 if (t.length > MAX_QUESTION_LENGTH) return false;
 if (t.includes('\n')) return false;

 const u = stripLeadingDecor(t);
 if (/^(?:[-*•+—–]|\d+[.)])/.test(u)) return false;

 // The output ends in a terminal CLUSTER of `?`/`!` that must contain at
 // least one question mark. One cluster is one terminal, so "Why?!" is a
 // single question rather than two sentences (H2-1); "Really!" still fails.
 let clusterStart = t.length;
 while (clusterStart > 0 && CLUSTER_MARK[t[clusterStart - 1]] === true) clusterStart--;
 if (clusterStart === t.length) return false; // no terminal at all
 let hasQuestion = false;
 for (let i = clusterStart; i < t.length; i++) {
  if (QUESTION_MARK[t[i]] === true) hasQuestion = true;
 }
 if (!hasQuestion) return false;

 const inQuote = quoteCoverage(t);
 for (let i = 0; i < clusterStart; i++) {
  const c = t[i];
  if (SENTENCE_TERMINAL[c] !== true) continue;
  if (inQuote[i] && QUESTION_MARK[c] === true) continue; // quoted question = speech
  if (c === '.' && isNonTerminalDot(t, i)) continue; // abbreviation or decimal
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

/**
 * Fold a string to the comparison form every predicate here tokenizes from:
 * lowercased, decomposed, with combining marks removed, so "café" and "cafe"
 * are the same token.
 *
 * The old form split on `/[^a-z0-9]+/`, which treats every non-ASCII
 * character as a DELIMITER: "café" became "caf", "déjà" vanished entirely
 * (both fragments under the 3-char floor), and the two predicates built to
 * catch the model restating the passage were blind to any accented word — the
 * exact output an accent-normalizing model produces (H2-2).
 */
function foldForCompare(s: string): string {
 return s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
}

/** Tokens of length >= 3, Unicode letters and numbers, diacritics folded. */
function contentWords(s: string): Set<string> {
 const words = new Set<string>();
 for (const token of foldForCompare(s).split(/[^\p{L}\p{N}]+/u)) {
  if (token.length < 3) continue;
  if (STOPWORDS[token] === true) continue;
  words.add(token);
 }
 return words;
}

/** Adjacent-word bigrams, lowercased with punctuation stripped. */
function wordBigrams(s: string): string[] {
 const tokens = foldForCompare(s)
  .split(/[^\p{L}\p{N}]+/u)
  .filter((t) => t.length > 0);
 const bigrams: string[] = [];
 for (let i = 0; i + 1 < tokens.length; i++) {
  bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
 }
 return bigrams;
}

/**
 * Reduce a word to a comparison stem, so an inflected form and its base
 * collapse to the same key ("walk"/"walked", "carry"/"carried",
 * "story"/"stories", "run"/"running").
 *
 * This is a light suffix stripper, not a linguistic stemmer — it exists only
 * to decide "same word?" for grounding:
 *  - strip ONE inflectional suffix (`ing`, `ied`/`ies`→`y`, `ed`, `es`, `s`),
 *  - drop a trailing silent `e` ("store"→"stor", so "stored"→"stor" agrees),
 *  - fold a trailing `y` to `i` ("carry"→"carri" agrees with "carried"),
 *  - undo a doubled final consonant ("stopped"→"stopp"→"stop").
 *
 * Comparing STEMS rather than substrings or prefixes is what makes grounding
 * mean "the question names a word that is in the text". A prefix test grounds
 * on accident whenever the accident sits at the front — "moth" in "mother",
 * "room" in "roommate", "light" in "lightning", "fall" in "fallout" — and it
 * misses every inflection that changes a letter, which are the commonest ones
 * in prose ("carry"/"carried", "story"/"stories"). Stems reject the first
 * class and keep the second.
 *
 * Irregular forms it cannot reach ("run"/"ran", "write"/"wrote",
 * "knife"/"knives") stay unmatched. That is the accepted cost: grounding is
 * one of four gate predicates, and a miss falls back to a topic probe rather
 * than showing the writer a question about words they never wrote.
 */
function stem(word: string): string {
 let s = word;
 if (s.length > 4 && s.endsWith('ing')) s = s.slice(0, -3);
 else if (s.length > 4 && (s.endsWith('ied') || s.endsWith('ies'))) s = s.slice(0, -3) + 'y';
 else if (s.length > 3 && (s.endsWith('ed') || s.endsWith('es'))) s = s.slice(0, -2);
 else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
 if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
 if (s.endsWith('y')) s = s.slice(0, -1) + 'i';
 const last = s[s.length - 1];
 if (s.length > 3 && last === s[s.length - 2] && !'aeiou'.includes(last)) s = s.slice(0, -1);
 return s;
}

/**
 * True iff the question and the text window share a content word, compared by
 * STEM (see `stem`) so inflections agree and coincidental overlap does not.
 * A stem must be at least 3 characters and at least one of the two original
 * words at least 4, which keeps short tokens from colliding while still
 * grounding "run" against "running". An empty question or window is never
 * grounded.
 */
export function isGrounded(question: string, textWindow: string): boolean {
 const questionWords = contentWords(question);
 const windowWords = contentWords(textWindow);
 if (questionWords.size === 0 || windowWords.size === 0) return false;
 const windowStems = new Map<string, number>();
 for (const w of windowWords) {
  const key = stem(w);
  const longest = windowStems.get(key) ?? 0;
  if (w.length > longest) windowStems.set(key, w.length);
 }
 for (const q of questionWords) {
  const hit = windowStems.get(stem(q));
  if (hit === undefined) continue;
  if (stem(q).length < 3) continue;
  if (Math.max(q.length, hit) < 4) continue;
  return true;
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
