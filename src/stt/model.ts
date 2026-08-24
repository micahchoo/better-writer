import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HF_REPO = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';

const REQUIRED_FILES = [
 'encoder.int8.onnx',
 'decoder.int8.onnx',
 'joiner.int8.onnx',
 'tokens.txt',
] as const;

export function resolveCacheDir(): string {
 return join(
  homedir(),
  '.cache/better-writer/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
 );
}

function dirHasAllFiles(dir: string): boolean {
 for (const file of REQUIRED_FILES) {
  try {
   accessSync(join(dir, file), constants.R_OK);
  } catch {
   return false;
  }
 }
 return true;
}

/**
 * Resolve the Parakeet TDT model directory:
 * 1. `BW_STT_MODEL_DIR` env var
 * 2. Cached path if all four model files are present
 * 3. Throw with a message naming the env var and HF repo
 */
export function resolveModelDir(): string {
 const envDir = process.env['BW_STT_MODEL_DIR'];
 if (envDir && dirHasAllFiles(envDir)) {
  return envDir;
 }

 if (envDir) {
  // S3-12: an explicitly-set but incomplete model dir must not be silently
  // ignored in favor of a different model — the operator pointed at a
  // specific folder, so name both the ignored env dir and what was used.
  console.warn(
   `[stt-model] BW_STT_MODEL_DIR=${envDir} is set but missing one of ` +
   `${REQUIRED_FILES.join(', ')}; ignoring it and falling back to ` +
   `cache at ${resolveCacheDir()}`,
  );
 }

 const cacheDir = resolveCacheDir();
 if (dirHasAllFiles(cacheDir)) {
  return cacheDir;
 }

 throw new Error(
  `Parakeet STT model not found. Set BW_STT_MODEL_DIR to a directory ` +
  `containing ${REQUIRED_FILES.join(', ')} from the HF repo ${HF_REPO}, ` +
  `or ensure the cache at ${cacheDir} is populated.`,
 );
}
