import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { Annotation } from './core/types.js';

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

  /**
   * Serializes every operation this seam performs, so a load can never observe
   * a write in progress.
   *
   * The server has its own ioSerial around the draft+annotation PAIR, but the
   * seam is exported and used directly by tests and any non-server caller,
   * where nothing protected it: an 800-race probe against 8 MB payloads
   * reproduced both a stale read and a torn one (H9-3). Serializing here makes
   * the seam safe by construction rather than by its caller remembering.
   */
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(io: () => Promise<T>): Promise<T> {
    const run = chain.then(io, io);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Write via a temporary file and rename. `writeFile` truncates and then
   * writes, so a reader outside this process — or a crash mid-write — can see
   * a half-written draft. `rename` is atomic within a filesystem, so a reader
   * sees either the old file or the new one, never a partial one.
   */
  async function writeAtomic(target: URL, text: string): Promise<void> {
    const tmp = new URL(`${target.pathname}.tmp`, target);
    try {
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, target);
    } catch (err) {
      // Creating the temp file needs a WRITABLE DIRECTORY; overwriting an
      // existing file only needs the file's own write bit. Where the directory
      // refuses us, fall back to a direct write: a save that lands without the
      // crash-atomicity guarantee beats a save that does not land at all. Say
      // so, because the guarantee is silently gone for this write.
      console.error('[draft] atomic write unavailable, writing in place:', err);
      await writeFile(target, text, 'utf8');
    }
  }

  async function loadDraft(): Promise<string> {
    return serial(async () => {
      try {
        return await readFile(draftUrl, 'utf8');
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return '';
        throw err;
      }
    });
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
    return serial(async () => {
      await mkdir(new URL('.', draftUrl), { recursive: true });
      await maybeBackup(text);
      await writeAtomic(draftUrl, text);
    });
  }

  async function saveAnnotations(list: Annotation[]): Promise<void> {
    return serial(async () => {
      await mkdir(new URL('.', annotationsUrl), { recursive: true });
      await writeAtomic(annotationsUrl, `${JSON.stringify(list)}\n`);
    });
  }

  /**
   * Load the annotations; an empty list when none are stored yet. A corrupt file
   * is logged and treated as empty — annotations are advisory and must never
   * block loading the editor.
   */
  async function loadAnnotations(): Promise<Annotation[]> {
    return serial(async () => {
    try {
      // First-hunt #13 / S3-15: any valid JSON parses, so a bare `as Annotation[]`
      // cast once served `{}` or `"notes"` straight to /load and crashed the
      // client during boot. Guard the shape like parseAnnotation does on write.
      const parsed: unknown = JSON.parse(await readFile(annotationsUrl, 'utf8'));
      if (!Array.isArray(parsed)) {
        console.error('[draft] annotations file is not an array, ignoring');
        return [];
      }
      return parsed.filter(
        (a): a is Annotation =>
          typeof a === 'object' && a !== null &&
          Number.isInteger((a as Annotation).start) && Number.isInteger((a as Annotation).end) &&
          (a as Annotation).start >= 0 && (a as Annotation).end > (a as Annotation).start,
      );
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
      console.error('[draft] corrupt annotations file, ignoring:', err);
      return [];
    }
    });
  }

  return { loadDraft, saveDraft, saveAnnotations, loadAnnotations };
}

/** The production instance: every save rotates a one-deep .backup first. */
export const defaultDraftIo = createDraftIo(DRAFT_FILE, ANNOTATIONS_FILE, { backupEveryNthSave: 1 });

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
