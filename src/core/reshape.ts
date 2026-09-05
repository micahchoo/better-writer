/** Legacy single-seed baseline for experiments. Production uses agent.ts. */
import { copiesSeed, echoesText, isGrounded, isSingleQuestion, stripCursorMarkers } from './gate.js';
import { topicProbe } from './topic-probe.js';
import type { Complete, QuestionSource } from './types.js';

/**
 * System prompt for the coach model, condensed from agent_sketch.md. The
 * seed's `verb`/`source`/`id` never reach this prompt — only its `question`.
 */
export const RESHAPE_SYSTEM = `You are the writer's coach: a small model that asks a writer ONE sharp question about their live text.
Never write prose for the writer, never edit their text, never explain your reasoning.
Output is the single reshaped question. Nothing else.`;

/** Why a model output failed the gate; selects the corrective nudge. */
type GateFailure = 'syntax' | 'ungrounded' | 'echo' | 'seedcopy' | 'transport';

/**
 * Outcome diagnostics for one reshape() call, delivered via `onAttempt`.
 * `failures` lists the gate reason for each bad model attempt (in order);
 * `fallback` is true when the topic probe was used; `attempts` is the number
 * of model calls made (1 on first-pass success or a transport failure that is
 * never retried, 2 after a gate-failure retry).
 */
export interface ReshapeAttempt {
 failures: GateFailure[];
 fallback: boolean;
 attempts: number;
}

/**
 * Corrective nudges appended verbatim on the single retry, keyed by the
 * first gate predicate the output failed. A reason-specific nudge exists
 * because the measured retry-rescue rate of one generic suffix was 7%.
 */
export const RETRY_SUFFIXES: Record<Exclude<GateFailure, 'transport'>, string> = {
 syntax:
  'Return only the single question, ending in ?. Nothing else.',
 ungrounded:
  'Your question did not mention anything from the writer\'s text. Ask about a specific detail from the text and quote its exact words in the question.',
 echo:
  'You restated the writer\'s sentences back as a question. Ask about their text without repeating their sentences — quote one small detail, then ask something new about it.',
 seedcopy:
  'You repeated the seed question almost verbatim. Do not reuse the seed\'s wording; write a fresh question about the writer\'s text.',
};

/**
 * The one prompt sent to the model every turn. Structure follows attention
 * realities of small models: the seed question leads (its intent must
 * survive), rules sit in the middle, and the passage comes last so it is
 * still in context — but a closing reminder repeats the binding constraint
 * (keep the CRAFT QUESTION'S intent) at the highest-attention position.
 */
export function buildPrompt(question: string, textWindow: string): string {
 return `You will reshape ONE craft question to fit the writer's passage.

Craft question (the intent you must keep):
${question}

Rules:
- Ask ONE question addressed to the writer ("you"), ending in ?
- Anchor it to one specific detail — quote the writer's exact words
- Keep the craft question's INTENT; use the passage only for that anchor
- If a [CURSOR START] / [CURSOR END] region exists, anchor to a detail inside it when possible

Passage:
${textWindow}

Reminder: ask ONE question that keeps the CRAFT QUESTION'S INTENT above,
anchored to a quoted detail from the PASSAGE above.`;
}

/**
 * Specialize a seed question against the writer's text window.
 *
 * Calls `complete` with the fixed reshape prompt; the output must pass the
 * full gate — syntactic (`isSingleQuestion`) plus grounding: `isGrounded`,
 * and neither `echoesText` nor `copiesSeed` (the gate rejects, never
 * rewrites). On a gate failure (a verdict on the model's output) retry ONCE
 * with the corrective suffix appended. A thrown model error is a transport
 * failure — a dead endpoint cannot be fixed by a nudge — so it is never
 * retried. Either way, fall back to a fixed topic probe so the writer is
 * never left without a question. The returned `source` labels which path produced the
 * text: 'reshaped' when a gated model output passed, 'topic-probe' on the
 * fallback — surfaced to the writer as honesty about the model's part. When
 * `onAttempt` is given, it is invoked once with the final outcome (failure
 * reasons, whether the probe fallback was used, and how many model calls
 * were made).
 */
export async function reshape(
 seedQuestion: string,
 textWindow: string,
 complete: Complete,
 onAttempt?: (info: ReshapeAttempt) => void,
): Promise<{ question: string; source: QuestionSource }> {
 const prompt = buildPrompt(seedQuestion, textWindow);

 const first = await tryComplete(complete, prompt, textWindow, seedQuestion);
 if (first.ok) {
  onAttempt?.({ failures: [], fallback: false, attempts: 1 });
  return { question: first.question, source: 'reshaped' };
 }

 if (first.reason === 'transport') {
  // A dead endpoint cannot be fixed by a nudge suffix — a retry would only
  // burn a second full timeout. Report the class honestly and fall back.
  onAttempt?.({ failures: [first.reason], fallback: true, attempts: 1 });
  return { question: topicProbe(textWindow), source: 'topic-probe' };
 }

 const retry = await tryComplete(
  complete,
  `${prompt}\n\n${RETRY_SUFFIXES[first.reason]}`,
  textWindow,
  seedQuestion,
 );
 if (retry.ok) {
  onAttempt?.({ failures: [first.reason], fallback: false, attempts: 2 });
  return { question: retry.question, source: 'reshaped' };
 }

 onAttempt?.({ failures: [first.reason, retry.reason], fallback: true, attempts: 2 });
 return { question: topicProbe(textWindow), source: 'topic-probe' };
}

/**
 * The model output, trimmed, when it passes the full gate (syntactic +
 * grounding); else the reason the first predicate rejected it.
 */
async function tryComplete(
 complete: Complete,
 prompt: string,
 textWindow: string,
 seedQuestion: string,
): Promise<{ ok: true; question: string } | { ok: false; reason: GateFailure }> {
 let output: string;
 try {
  output = await complete(RESHAPE_SYSTEM, [{ role: 'user', text: prompt }]);
 } catch {
  return { ok: false, reason: 'transport' };
 }
 // Decode our transport tokens out of the answer before the gate sees it.
 const trimmed = stripCursorMarkers(output)
  .replace(/\s{2,}/g, ' ')
  .trim();
 if (!isSingleQuestion(trimmed)) return { ok: false, reason: 'syntax' };
 if (!isGrounded(trimmed, textWindow)) return { ok: false, reason: 'ungrounded' };
 if (echoesText(trimmed, textWindow)) return { ok: false, reason: 'echo' };
 if (copiesSeed(trimmed, seedQuestion)) return { ok: false, reason: 'seedcopy' };
 return { ok: true, question: trimmed };
}
