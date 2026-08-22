import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Annotation } from './types.js';

/** data/drafts/current.md, resolved from the module (not cwd). */
const DRAFT_FILE = new URL('../data/drafts/current.md', import.meta.url);

/** data/annotations/current.json, resolved from the module (not cwd). */
const ANNOTATIONS_FILE = new URL('../data/annotations/current.json', import.meta.url);

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

/** Save the annotations, creating data/annotations/ as needed. */
export async function saveAnnotations(list: Annotation[]): Promise<void> {
 await mkdir(new URL('.', ANNOTATIONS_FILE), { recursive: true });
 await writeFile(ANNOTATIONS_FILE, `${JSON.stringify(list)}\n`, 'utf8');
}

/**
 * Load the annotations; an empty list when none are stored yet. A corrupt file
 * is logged and treated as empty — annotations are advisory and must never
 * block loading the editor.
 */
export async function loadAnnotations(): Promise<Annotation[]> {
 try {
  return JSON.parse(await readFile(ANNOTATIONS_FILE, 'utf8')) as Annotation[];
 } catch (err) {
  if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
  console.error('[draft] corrupt annotations file, ignoring:', err);
  return [];
 }
}
