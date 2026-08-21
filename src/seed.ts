import { execFile, type ExecFileException } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Genre, Seed } from './types.js';

const execFileAsync = promisify(execFile);

/** Resolved from the module, NOT cwd, so the server works from any directory. */
const RETRIEVE_PY = fileURLToPath(new URL('../seeds/retrieve.py', import.meta.url));

/**
 * Parse the JSON array `retrieve.py pull` prints to stdout and return the
 * first seed. Pure — tests exercise this directly without shelling out.
 * Throws a clear error on empty output, unparseable JSON, or a malformed seed.
 */
export function parsePullOutput(stdout: string): Seed {
 let parsed: unknown;
 try {
  parsed = JSON.parse(stdout);
 } catch (err) {
  throw new Error(`seed pull returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
 }
 if (!Array.isArray(parsed) || parsed.length === 0) {
  throw new Error('seed pull returned no seeds (empty array)');
 }
 const first = parsed[0];
 if (typeof first !== 'object' || first === null) {
  throw new Error('seed pull returned a malformed seed (missing question)');
 }
 // Only `question` is runtime input; verify it, then trust retrieve.py's schema.
 if (!('question' in first) || typeof first.question !== 'string') {
  throw new Error('seed pull returned a malformed seed (missing question)');
 }
 return first as Seed;
}

/**
 * Pull one random seed for a genre by shelling out to `retrieve.py pull`.
 * The genre is used once to select the seed and then discarded — it is never
 * runtime input to the model.
 */
export async function pullSeed(genre: Genre): Promise<Seed> {
 let stdout: string;
 try {
  const { stdout: out } = await execFileAsync(
   'python3',
   [RETRIEVE_PY, 'pull', '--genre', genre],
   { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  stdout = out;
 } catch (err) {
  // promisify(execFile) rejects with ExecFileException, which carries stderr.
  const execErr = err as ExecFileException;
  const detail =
   typeof execErr.stderr === 'string' && execErr.stderr.trim() !== ''
    ? execErr.stderr.trim()
    : execErr.message;
  throw new Error(`seed pull failed for genre "${genre}": ${detail}`);
 }
 return parsePullOutput(stdout);
}
