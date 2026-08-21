import { isSingleQuestion } from './gate.js';
import { topicProbe } from './topic-probe.js';
import type { Complete } from './types.js';

/**
 * System prompt for the coach model, condensed from agent_sketch.md. The
 * seed's `verb`/`source`/`id` never reach this prompt — only its `question`.
 */
const RESHAPE_SYSTEM = `You are the writer's coach: a small model that asks a writer ONE sharp question about their live text.
Never write prose for the writer, never edit their text, never explain your reasoning.
Output is the single reshaped question. Nothing else.`;

/** Corrective nudge appended verbatim on the single retry. */
const RETRY_SUFFIX = 'Return only the single question. Nothing else.';

/** The one prompt sent to the model every turn (verbatim from agent_sketch.md). */
function buildPrompt(question: string, textWindow: string): string {
 return `Reshape this question so it fits the writer's text.
Keep its intent. Replace generic nouns with what is actually in the text.
Ask ONE question, addressed to the writer, in their own words.

Question: ${question}

Writer's text:
${textWindow}`;
}

/**
 * Specialize a seed question against the writer's text window.
 *
 * Calls `complete` with the fixed reshape prompt; the output must pass
 * `isSingleQuestion` (the gate rejects, never rewrites). On a gate failure —
 * or a thrown model error, which is treated the same way — retry ONCE with
 * the corrective suffix appended. If that also fails, fall back to a fixed
 * topic probe so the writer is never left without a question.
 */
export async function reshape(
 seedQuestion: string,
 textWindow: string,
 complete: Complete,
): Promise<string> {
 const prompt = buildPrompt(seedQuestion, textWindow);

 const first = await tryComplete(complete, prompt);
 if (first !== null) return first;

 const retry = await tryComplete(complete, `${prompt}\n\n${RETRY_SUFFIX}`);
 if (retry !== null) return retry;

 return topicProbe(textWindow);
}

/** The model output, trimmed, when it passes the gate; else null. */
async function tryComplete(complete: Complete, prompt: string): Promise<string | null> {
 let output: string;
 try {
  output = await complete(RESHAPE_SYSTEM, [{ role: 'user', text: prompt }]);
 } catch {
  return null;
 }
 const trimmed = output.trim();
 return isSingleQuestion(trimmed) ? trimmed : null;
}
