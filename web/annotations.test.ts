import { describe, expect, it } from 'vitest';
import { mapAnnotations } from './annotations';
import { makeNote, migrateNotes, noteId } from './notes';
import { LocalStorageDraftStore } from './draft-store';

describe('live annotation mapping', () => {
  it('keeps a duplicate occurrence and stable identity after insertion before it', async () => {
    const note = makeNote({ start: 6, end: 11, fragment: 'hello' }, 'Why?', 1);
    const [mapped] = mapAnnotations([note], [{ from: 0, to: 0, insert: 'hello ' }]);
    expect(mapped.start).toBe(12);
    expect(noteId(mapped)).toBe(noteId(note));
    const data = new Map<string, string>();
    const store = new LocalStorageDraftStore({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } });
    await store.save('hello hello hello', [mapped]);
    expect(noteId((await store.loadAnnotations())[0])).toBe(noteId(note));
  });
  it('drops evidence changed internally even if an identical occurrence remains', () => {
    const note = makeNote({ start: 6, end: 11, fragment: 'hello' }, 'Why?');
    expect(mapAnnotations([note], [{ from: 7, to: 8, insert: 'a' }])).toEqual([]);
    expect(mapAnnotations([note], [{ from: 7, to: 7, insert: 'a' }])).toEqual([]);
  });
  it('maps all changes against original offsets with explicit boundary affinity', () => {
    const note = makeNote({ start: 6, end: 11, fragment: 'hello' }, 'Why?');
    expect(mapAnnotations([note], [{ from: 0, to: 2, insert: '' }, { from: 6, to: 6, insert: '!' }, { from: 11, to: 11, insert: '!' }])[0]).toMatchObject({ start: 5, end: 10 });
  });
  it('migrates legacy identities deterministically and retains them after mapping', () => {
    const legacy = { start: 0, end: 5, fragment: 'hello', question: 'Why?', ts: 1 };
    const first = migrateNotes([legacy, legacy]);
    expect(first).toEqual(migrateNotes([legacy, legacy]));
    expect(first[0].id).not.toBe(first[1].id);
    expect(migrateNotes(mapAnnotations(first, [{ from: 0, to: 0, insert: 'x' }]))[0].id).toBe(first[0].id);
  });
});
