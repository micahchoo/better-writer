import { GENRES, type CoachInput, type CoachResult } from './types.js';
import { isSingleQuestion } from './gate.js';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

/** Validate transport data before it reaches the agent or the editor. */
export function parseCoachInput(value: unknown): CoachInput | null {
  if (!object(value) || typeof value.textWindow !== 'string' ||
      !GENRES.includes(value.genre as CoachInput['genre']) ||
      !integer(value.cursorOffset) || value.cursorOffset < 0) return null;
  const input: CoachInput = { textWindow: value.textWindow, genre: value.genre as CoachInput['genre'], cursorOffset: value.cursorOffset };
  if (value.focus !== undefined) {
    const f = value.focus;
    if (!object(f) || !integer(f.start) || !integer(f.end) || f.start < 0 || f.end <= f.start || f.end > input.textWindow.length) return null;
    input.focus = { start: f.start, end: f.end };
  }
  if (value.position !== undefined) {
    const p = value.position;
    if (!object(p) || !integer(p.sectionBlockCount) || !integer(p.blockIndexInSection) ||
        p.sectionBlockCount < 1 || p.blockIndexInSection < 0 || p.blockIndexInSection >= p.sectionBlockCount) return null;
    input.position = { sectionBlockCount: p.sectionBlockCount, blockIndexInSection: p.blockIndexInSection };
  }
  return input;
}

export function parseCoachResult(value: unknown, input: CoachInput): CoachResult {
  const invalid: CoachResult = { kind: 'unavailable', retryable: false };
  if (!object(value)) return invalid;
  if (value.kind === 'skip' && (value.reason === 'no-fit' || value.reason === 'invalid-output')) return { kind: 'skip', reason: value.reason };
  if (value.kind === 'unavailable' && typeof value.retryable === 'boolean') return { kind: 'unavailable', retryable: value.retryable };
  if (value.kind !== 'question' || value.source !== 'reshaped' || typeof value.question !== 'string' || !isSingleQuestion(value.question)) return invalid;
  const e = value.evidence;
  if (!object(e) || typeof e.quote !== 'string' || !e.quote.trim() || !integer(e.start) || !integer(e.end)) return invalid;
  const focus = input.focus ?? { start: 0, end: input.textWindow.length };
  if (e.start < focus.start || e.end > focus.end || e.end <= e.start ||
      input.textWindow.slice(e.start, e.end) !== e.quote || !value.question.includes(e.quote)) return invalid;
  return { kind: 'question', source: 'reshaped', question: value.question, evidence: { quote: e.quote, start: e.start, end: e.end } };
}
