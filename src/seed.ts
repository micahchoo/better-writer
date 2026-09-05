import { execFile, type ExecFileException } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Genre, Seed, Verb } from './core/types.js';

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
 *
 * Options narrow the draw without changing the fallback contract:
 *  - `leanVerbs` (an implementation-verb set from the /ask flow) is appended
 *    as `--lean-verbs a,b`. retrieve.py treats it as a SOFT preference (a
 *    two-stage draw), so it can never empty the pool — no retry is needed.
 *    Empty/absent leanVerbs leave the command line exactly as before.
 *
 * The legacy second argument (`verb?: Verb`) is still accepted for
 * backward compatibility: when a verb string is given it narrows to that
 * verb's bucket via `--verb`. If the verb'd call fails for ANY reason —
 * exec rejection, or an empty bucket (parsePullOutput throws on an empty
 * JSON array) — it retries ONCE with no verb and returns whatever the
 * uniform lottery yields. Without a verb, errors propagate as before.
 */
export interface PullSeedOptions {
  /** Soft verb-set preference (`--lean-verbs`); never empties the pool. */
  leanVerbs?: string[];
}

export async function pullSeed(
 genre: Genre,
 opts?: PullSeedOptions | Verb,
): Promise<Seed> {
 const verb = typeof opts === 'string' ? opts : undefined;
 const leanVerbs = typeof opts === 'string' ? undefined : opts?.leanVerbs;
 const args = [RETRIEVE_PY, 'pull', '--genre', genre];
 if (verb !== undefined) {
  args.push('--verb', verb);
 }
 if (leanVerbs !== undefined && leanVerbs.length > 0) {
  args.push('--lean-verbs', leanVerbs.join(','));
 }
 try {
  const { stdout: out } = await execFileAsync(
   'python3',
   args,
   { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  return parsePullOutput(out);
 } catch (err) {
  if (verb !== undefined) {
   // Verb bucket came up empty or the verb'd call failed — fall back to the
   // uniform lottery. One level deep at most: this call has no verb.
   return pullSeed(genre);
  }
  // promisify(execFile) rejects with ExecFileException, which carries stderr.
  const execErr = err as ExecFileException;
  const detail =
   typeof execErr.stderr === 'string' && execErr.stderr.trim() !== ''
    ? execErr.stderr.trim()
    : execErr.message;
  throw new Error(`seed pull failed for genre "${genre}": ${detail}`);
 }
}
