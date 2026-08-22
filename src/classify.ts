import type { Complete, Verb } from './types.js';

/**
 * The system prompt for the verb classifier: one diagnostic pass over the
 * passage, answered with the THREE most useful interventions, one per line.
 */
export const CLASSIFY_SYSTEM: string = `You are a writing coach's diagnostic step. A writer shows you a passage of their work-in-progress. Decide which interventions would most help this passage RIGHT NOW.
The seven possible interventions:
- cut: wordy, redundant, repetitive - needs trimming
- elaborate: thin, underdeveloped, too brief - needs more detail
- elucidate: abstract, tells instead of shows, vague - needs clarifying/concretizing
- transition: sits at a seam or jump between ideas/scenes - needs connecting
- concept-form: the claim or idea is fuzzy, not yet shaped - needs a sharper concept
- rephrase: specific phrases are awkward, tangled, or wrong-sounding
- rewrite: the sentences are flat or weak and need to be written better
Reply with the THREE most useful interventions in order, one per line, using only the seven words above. Most useful first. No explanations.`;

/** The seven valid intervention verbs, for runtime validation of model output. */
const VERB_LOOKUP: Record<string, true> = {
  cut: true,
  elaborate: true,
  elucidate: true,
  transition: true,
  'concept-form': true,
  rephrase: true,
  rewrite: true,
};

function isVerb(token: string): token is Verb {
  return VERB_LOOKUP[token] === true;
}

/**
 * Parse the model's ranked reply into a shortlist of valid verbs.
 *
 * Each line is trimmed, lowercased, stripped of a leading `N.` / `N)` marker
 * and one trailing `.`/`-`/`:` character, then kept only if it is a valid
 * verb. Duplicates are dropped preserving first-seen order, and the result
 * is capped at three.
 */
function parseRanked(output: string): Verb[] {
  const seen = new Set<Verb>();
  const ranked: Verb[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim().toLowerCase();
    if (line.length === 0) {
      continue;
    }
    const stripped = line.replace(/^\d+[.)]\s*/, '').replace(/[.\-:]$/, '');
    if (!isVerb(stripped)) {
      continue;
    }
    if (seen.has(stripped)) {
      continue;
    }
    seen.add(stripped);
    ranked.push(stripped);
  }
  return ranked.slice(0, 3);
}

/**
 * Ask the coach which three interventions would most help the passage right
 * now. Returns the ranked shortlist, most useful first, at most three verbs.
 * Never throws: a model error or unparseable output yields [].
 */
export async function classifyVerbs(
  textWindow: string,
  complete: Complete,
): Promise<Verb[]> {
  let output: string;
  try {
    output = await complete(CLASSIFY_SYSTEM, [
      { role: 'user', text: `Passage:\n${textWindow}\n\nMost useful interventions, ranked:` },
    ]);
  } catch {
    return [];
  }
  return parseRanked(output);
}

/**
 * Sample one verb from the ranked shortlist — the narrowing prior, never a
 * hard gate. An empty shortlist yields null; with probability `floor`
 * (default 0.12) the sample is null too, meaning "pull uniform, no verb
 * filter". Otherwise ranks 1..3 are weighted [0.6, 0.25, 0.15] (truncated to
 * the list length and renormalized), so a 1-verb list always yields that verb
 * unless the floor hits.
 */
export function pickVerb(ranked: Verb[], floor?: number): Verb | null {
  if (ranked.length === 0) {
    return null;
  }
  const floorProb = floor ?? 0.12;
  if (Math.random() < floorProb) {
    return null;
  }
  const weights = [0.6, 0.25, 0.15].slice(0, ranked.length);
  const total = weights.reduce((sum, w) => sum + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) {
      return ranked[i];
    }
  }
  return ranked[weights.length - 1];
}
