import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDraftIo } from './draft.js';
import type { Annotation } from './types.js';

/** One temp directory per test, torn down after — real fs, no mocks. */
let dir: string;
let draftUrl: URL;
let annotationsUrl: URL;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-draft-'));
  draftUrl = pathToFileURL(join(dir, 'drafts', 'current.md'));
  annotationsUrl = pathToFileURL(join(dir, 'annotations', 'current.json'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function draftPath(): string {
  return fileURLToPath(draftUrl);
}

function backupPath(): string {
  return `${draftPath()}.backup`;
}

describe('createDraftIo round-trip', () => {
  it('saves and reloads a draft, creating the directory', async () => {
    const io = createDraftIo(draftUrl, annotationsUrl);
    await io.saveDraft('first paragraph');
    expect(await io.loadDraft()).toBe('first paragraph');
    expect(readFileSync(draftPath(), 'utf8')).toBe('first paragraph');
  });

  it('returns an empty string for a draft that has never been saved', async () => {
    const io = createDraftIo(draftUrl, annotationsUrl);
    expect(await io.loadDraft()).toBe('');
  });

  it('round-trips annotations with a trailing newline, creating the directory', async () => {
    const io = createDraftIo(draftUrl, annotationsUrl);
    const list: Annotation[] = [
      { start: 0, end: 5, fragment: 'hello', question: 'why?', ts: 1 },
    ];
    await io.saveAnnotations(list);
    expect(await io.loadAnnotations()).toEqual(list);
    expect(readFileSync(fileURLToPath(annotationsUrl), 'utf8')).toBe(
      `${JSON.stringify(list)}\n`,
    );
  });

  it('returns an empty list when no annotations file exists', async () => {
    const io = createDraftIo(draftUrl, annotationsUrl);
    expect(await io.loadAnnotations()).toEqual([]);
  });

  it('treats a corrupt annotations file as an empty list and logs it', async () => {
    const io = createDraftIo(draftUrl, annotationsUrl);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { mkdirSync } = await import('node:fs');
    mkdirSync(fileURLToPath(new URL('.', annotationsUrl)), { recursive: true });
    writeFileSync(fileURLToPath(annotationsUrl), '{not json', 'utf8');
    expect(await io.loadAnnotations()).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      '[draft] corrupt annotations file, ignoring:',
      expect.any(Error),
    );
  });
});

describe('createDraftIo backup rotation', () => {
  it('writes a backup on the Nth save and not on the others', async () => {
    const io = createDraftIo(draftUrl, annotationsUrl, { backupEveryNthSave: 2 });
    await io.saveDraft('v1');
    expect(() => readFileSync(backupPath(), 'utf8')).toThrow(); // no backup yet
    await io.saveDraft('v2');
    expect(readFileSync(backupPath(), 'utf8')).toBe('v1');
    await io.saveDraft('v3');
    expect(readFileSync(backupPath(), 'utf8')).toBe('v1'); // unchanged
    await io.saveDraft('v4');
    expect(readFileSync(backupPath(), 'utf8')).toBe('v3');
  });

  it('does not write a backup when the incoming text is identical', async () => {
    const io = createDraftIo(draftUrl, annotationsUrl, { backupEveryNthSave: 1 });
    await io.saveDraft('same');
    await io.saveDraft('same');
    expect(() => readFileSync(backupPath(), 'utf8')).toThrow();
  });

  it('skips the backup when nothing is on disk yet, then backs up later saves', async () => {
    const io = createDraftIo(draftUrl, annotationsUrl, { backupEveryNthSave: 1 });
    await io.saveDraft('first'); // nothing on disk -> skip silently
    expect(() => readFileSync(backupPath(), 'utf8')).toThrow();
    await io.saveDraft('second');
    expect(readFileSync(backupPath(), 'utf8')).toBe('first');
  });

  it('does not fail the save when the backup copy fails (readonly dir)', async () => {
    const io = createDraftIo(draftUrl, annotationsUrl, { backupEveryNthSave: 1 });
    await io.saveDraft('first'); // creates drafts/ with a writable current.md
    // Make the drafts/ dir readonly so creating current.md.backup fails, while
    // overwriting the existing current.md (file-owned write bit) still succeeds.
    const { chmodSync } = await import('node:fs');
    chmodSync(join(dir, 'drafts'), 0o555);
    try {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      await io.saveDraft('second'); // backup attempt must fail, save must survive
      expect(readFileSync(draftPath(), 'utf8')).toBe('second');
      expect(log).toHaveBeenCalledWith('[draft] backup failed:', expect.any(Error));
    } finally {
      chmodSync(join(dir, 'drafts'), 0o755); // restore so afterEach can clean up
    }
  });
});
