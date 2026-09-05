/** Local HTTP + Bonsai smoke test. Uses synthetic prose and never writes a draft. */
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { LocalCoach } from '../web/coach.js';
import type { CoachInput } from '../src/core/types.js';

process.env.BW_PORT ??= '49882';
const { startServer } = await import('../src/server.js');
const server = startServer();
await once(server, 'listening');
const url = `http://127.0.0.1:${process.env.BW_PORT}`;
const input: CoachInput = {
  textWindow: 'My grandmother cooked with her wrists, not her hands. She lifted the heavy iron skillet with a flick that looked careless and set it on the burner as if it weighed nothing. I stood in the doorway and waited for her to notice me.',
  genre: 'memoir', cursorOffset: 0,
  focus: { start: 0, end: 99 }, position: { sectionBlockCount: 1, blockIndexInSection: 0 },
};
input.focus!.end = input.textWindow.length;
try {
  const health = await fetch(`${url}/health`);
  if (!health.ok) throw new Error(`health returned ${health.status}`);
  // Match the first fixture's candidate pool in eval-agent.ts.
  let state = 20260905;
  Math.random = () => ((state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 4294967296);
  const coach = new LocalCoach(url);
  const result = await coach.ask(input);
  if (result.kind !== 'question') throw new Error(`Expected a grounded question through HTTP, received ${result.kind}`);
  if (result.kind === 'question' && !result.evidence) throw new Error('Local question omitted evidence');
  const controller = new AbortController();
  const pending = coach.ask(input, controller.signal);
  const timer = setTimeout(() => controller.abort(), 50);
  let canceled = false;
  try { await pending; } catch (error) { canceled = error instanceof Error && error.name === 'AbortError'; }
  finally { clearTimeout(timer); }
  if (!canceled) throw new Error('Request did not propagate cancellation');
  const report = { generatedAt: new Date().toISOString(), url, health: health.status, input, result, canceled };
  await mkdir('docs/evals', { recursive: true });
  await writeFile('docs/evals/bonsai-server.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
