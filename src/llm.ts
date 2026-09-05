import { complete } from '@mariozechner/pi-ai';
import type { Model, Context } from '@mariozechner/pi-ai';
import type { Complete, Turn } from './core/types.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8088/v1';
const DEFAULT_MODEL_ID = 'bonsai-27b';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOKENS = 512;

/** Build a pi-ai Model for a local OpenAI-compatible endpoint
 * (llama.cpp and Ollama both serve /v1/chat/completions). */
function buildModel(baseUrl: string, modelId: string): Model<'openai-completions'> {
  return {
    id: modelId,
    name: `${modelId} (local, coach)`,
    api: 'openai-completions',
    provider: 'llama.cpp',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16384,
    maxTokens: 32000,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      // Emit `max_tokens`, the field both local backends read. pi-ai would
      // otherwise pick `max_completion_tokens` for any non-OpenAI baseUrl,
      // and Ollama's OpenAI layer has no such field.
      maxTokensField: 'max_tokens',
    },
  };
}

/** The endpoint the coach calls right now, read from the environment. */
export function coachConfig(): { baseUrl: string; modelId: string } {
  return {
    baseUrl: process.env.BW_LLM_BASE_URL ?? DEFAULT_BASE_URL,
    modelId: process.env.BW_LLM_MODEL ?? DEFAULT_MODEL_ID,
  };
}

function coachFailure(cfg: { baseUrl: string; modelId: string }, detail: string): Error {
  const message = `coach model call failed — ${cfg.modelId} at ${cfg.baseUrl}: ${detail}`;
  console.error(message);
  return new Error(message);
}

/** Create a Complete backed by the local coach endpoint. */
export function makeComplete(options?: { timeoutMs?: number; maxTokens?: number }): Complete {
  const cfg = coachConfig();
  const model = buildModel(cfg.baseUrl, cfg.modelId);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;

  return async (system: string, turns: Turn[], opts?: { temperature?: number; signal?: AbortSignal }): Promise<string> => {
    opts?.signal?.throwIfAborted();
    // pi-ai serializes assistant content by filtering CONTENT BLOCKS — a plain
    // string throws inside its provider. User content may be a string;
    // assistant content must be [{type:'text', text}].
    const messages = turns.map((t) => {
      const now = Date.now();
      if (t.role === 'agent') {
        return {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: t.text }],
          timestamp: now,
        };
      }
      return { role: 'user' as const, content: t.text, timestamp: now };
    });

    const context = { systemPrompt: system, messages } as Context;

    // Caller cancellation propagates; elapsed model budgets remain failures.
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(opts?.signal?.reason);
    opts?.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const callOptions = {
      apiKey: 'none', // local endpoint does not require auth
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      signal: controller.signal,
      maxTokens,
    };

    let response;
    try {
      response = await complete(model, context, callOptions);
    } catch (err) {
      opts?.signal?.throwIfAborted();
      if (controller.signal.aborted) {
        throw coachFailure(cfg, `timed out after ${timeoutMs / 1000}s`);
      }
      throw coachFailure(cfg, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', abortFromCaller);
    }

    opts?.signal?.throwIfAborted();

    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      if (controller.signal.aborted) {
        throw coachFailure(cfg, `timed out after ${timeoutMs / 1000}s`);
      }
      const detail = (response as { errorMessage?: string }).errorMessage ?? 'no detail';
      throw coachFailure(cfg, detail);
    }

    const parts: string[] = [];
    for (const block of response.content) {
      if (block.type === 'text') parts.push(block.text);
    }
    return parts.join('');
  };
}
