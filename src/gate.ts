/**
 * The gate: decide whether a model output is ONE question and nothing else.
 *
 * The gate is deliberately syntactic — it cannot read intent — so it accepts
 * iff ALL of:
 *  - trimmed and non-empty
 *  - ends with exactly one `?` (the only `?` in the string is the last char)
 *  - single line (no `\n`)
 *  - no list marker at the start (`-`, `*`, `•`, or `1.`-style)
 *  - no trailing non-whitespace after the final `?`
 *
 * It rejects, never rewrites. Outputs that fail go back to the model once,
 * then fall back to a topic probe (see reshape.ts).
 */
export function isSingleQuestion(s: string): boolean {
 const t = s.trim();
 if (t.length === 0) return false;
 if (t.includes('\n')) return false;
 if (/^(?:[-*•]|\d+\.)/.test(t)) return false;

 let questionMark = -1;
 for (let i = 0; i < t.length; i++) {
  if (t[i] !== '?') continue;
  if (questionMark !== -1) return false; // a second `?`
  questionMark = i;
 }
 if (questionMark === -1) return false; // no `?`
 if (questionMark !== t.length - 1) return false; // trailing text after `?`
 return true;
}
