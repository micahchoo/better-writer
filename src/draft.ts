import { mkdir, readFile, writeFile } from 'node:fs/promises';

/** data/drafts/current.md, resolved from the module (not cwd). */
const DRAFT_FILE = new URL('../data/drafts/current.md', import.meta.url);

/** Load the draft; an empty string when no draft has been saved yet. */
export async function loadDraft(): Promise<string> {
 try {
  return await readFile(DRAFT_FILE, 'utf8');
 } catch (err) {
  if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return '';
  throw err;
 }
}

/** Save the draft, creating data/drafts/ as needed. */
export async function saveDraft(text: string): Promise<void> {
 await mkdir(new URL('.', DRAFT_FILE), { recursive: true });
 await writeFile(DRAFT_FILE, text, 'utf8');
}
