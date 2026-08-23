import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Annotation } from './types.js';

/** data/drafts/current.md, resolved from the module (not cwd). */
const DRAFT_FILE = new URL('../data/drafts/current.md', import.meta.url);

/** data/annotations/current.json, resolved from the module (not cwd). */
const ANNOTATIONS_FILE = new URL('../data/annotations/current.json', import.meta.url);

/** Options for a draft/annotation io instance. */
export interface DraftIoOptions {
  /**
   * Back up the on-disk draft to `${draft}.backup` before every Nth overwrite
   * (N counted in saveDraft calls). Skipped when nothing is on disk yet or the
   * incoming text is byte-identical to what is there. A failed backup never
   * blocks the save.
   */
  backupEveryNthSave?: number;
}

/** The draft/annotation persistence seam, bound to concrete file URLs. */
export interface DraftIo {
  loadDraft(): Promise<string>;
  saveDraft(text: string): Promise<void>;
  saveAnnotations(list: Annotation[]): Promise<void>;
  loadAnnotations(): Promise<Annotation[]>;
}

/**
 * Build a persistence seam over explicit file URLs. Used directly by tests and
 * once for the production instance below.
 */
export function createDraftIo(
  draftUrl: URL,
  annotationsUrl: URL,
  opts: DraftIoOptions = {},
): DraftIo {
  // Count of saveDraft calls, so rotation lands on the Nth, 2Nth, ... write.
  let saveCount = 0;

  async function loadDraft(): Promise<string> {
    try {
      return await readFile(draftUrl, 'utf8');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return '';
      throw err;
    }
  }

  /** Back up the current on-disk draft before overwriting, when rotation is due. */
  async function maybeBackup(text: string): Promise<void> {
    if (opts.backupEveryNthSave == null) return;
    saveCount += 1;
    if (saveCount % opts.backupEveryNthSave !== 0) return;
    try {
      // Reading first both detects "nothing on disk yet" (ENOENT -> silent skip)
      // and lets us skip a no-op backup when the content is unchanged.
      const existing = await readFile(draftUrl, 'utf8');
      if (existing === text) return;
      try {
        await copyFile(draftUrl, new URL(`${draftUrl.pathname}.backup`, draftUrl));
      } catch (err) {
        console.error('[draft] backup failed:', err);
      }
    } catch (err) {
      // ENOENT here means no draft has ever been written — nothing to back up.
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
        console.error('[draft] backup failed:', err);
      }
    }
  }

  async function saveDraft(text: string): Promise<void> {
    await mkdir(new URL('.', draftUrl), { recursive: true });
    await maybeBackup(text);
    await writeFile(draftUrl, text, 'utf8');
  }

  async function saveAnnotations(list: Annotation[]): Promise<void> {
    await mkdir(new URL('.', annotationsUrl), { recursive: true });
    await writeFile(annotationsUrl, `${JSON.stringify(list)}\n`, 'utf8');
  }

  /**
   * Load the annotations; an empty list when none are stored yet. A corrupt file
   * is logged and treated as empty — annotations are advisory and must never
   * block loading the editor.
   */
  async function loadAnnotations(): Promise<Annotation[]> {
    try {
      return JSON.parse(await readFile(annotationsUrl, 'utf8')) as Annotation[];
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
      console.error('[draft] corrupt annotations file, ignoring:', err);
      return [];
    }
  }

  return { loadDraft, saveDraft, saveAnnotations, loadAnnotations };
}

/** The production instance: no rotation, identical to the pre-refactor module. */
export const defaultDraftIo = createDraftIo(DRAFT_FILE, ANNOTATIONS_FILE);

/** Load the draft; an empty string when no draft has been saved yet. */
export async function loadDraft(): Promise<string> {
  return defaultDraftIo.loadDraft();
}

/** Save the draft, creating data/drafts/ as needed. */
export async function saveDraft(text: string): Promise<void> {
  await defaultDraftIo.saveDraft(text);
}

/** Save the annotations, creating data/annotations/ as needed. */
export async function saveAnnotations(list: Annotation[]): Promise<void> {
  await defaultDraftIo.saveAnnotations(list);
}

/** Load the annotations; an empty list when none are stored yet. */
export async function loadAnnotations(): Promise<Annotation[]> {
  return defaultDraftIo.loadAnnotations();
}
