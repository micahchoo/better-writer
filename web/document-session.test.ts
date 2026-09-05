import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentSession } from './document-session';
import { makeNote } from './notes';
import { LocalStorageDraftStore } from './draft-store';

function store(draft = 'hello hello') {
  return { load: vi.fn().mockResolvedValue(draft), loadAnnotations: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue(undefined) };
}
const sessions: DocumentSession[] = [];
function session(persistence = store()) { const session = new DocumentSession(persistence); sessions.push(session); return session; }
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.useRealTimers(); });

describe('DocumentSession ownership', () => {
  it('rejects results from another session and maps its own delayed evidence', async () => {
    const first = session(), second = session();
    await Promise.all([first.load(), second.load()]);
    const captured = first.capture();
    const note = makeNote({ start: 6, end: 11, fragment: 'hello' }, 'Why?');
    expect(second.add(note, captured)).toBe(false);
    first.edit('xhello hello', [{ from: 0, to: 0, insert: 'x' }]);
    expect(first.add(note, captured)).toBe(true);
    expect(first.snapshot.notes[0]).toMatchObject({ id: note.id, start: 7, end: 12 });
  });
  it('rejects delayed evidence that was edited even when the text is restored', async () => {
    const document = session(); await document.load();
    const captured = document.capture();
    document.edit('hello hallo'); document.edit('hello hello');
    expect(document.add(makeNote({ start: 6, end: 11, fragment: 'hello' }, 'Why?'), captured)).toBe(false);
  });
  it('retains edits made during load and never saves a placeholder', async () => {
    vi.useFakeTimers();
    const persistence = store();
    let finish!: (draft: string) => void;
    persistence.load.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    const document = session(persistence);
    const loading = document.load();
    await document.flush();
    expect(persistence.save).not.toHaveBeenCalled();
    document.edit('mine');
    await vi.advanceTimersByTimeAsync(2000);
    await document.flush();
    expect(persistence.save).not.toHaveBeenCalled();
    finish('older'); await loading;
    expect(document.snapshot).toMatchObject({ draft: 'mine', notes: [], ready: true });
    await document.flush();
    expect(persistence.save).toHaveBeenCalledWith('mine', [], undefined);
  });
  it('ignores a load completed after disposal and does not write', async () => {
    const persistence = store();
    let finish!: (draft: string) => void;
    persistence.load.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    const document = session(persistence), loading = document.load();
    document.dispose(); finish('old'); await loading;
    expect(document.snapshot.ready).toBe(false);
    expect(persistence.save).not.toHaveBeenCalled();
  });
  it('each session saves only to the store it was created with', async () => {
    const a = store(), b = store(); const first = session(a), second = session(b);
    await Promise.all([first.load(), second.load()]);
    first.edit('first'); second.edit('second');
    await Promise.all([first.flush(), second.flush()]);
    expect(a.save).toHaveBeenCalledWith('first', [], undefined);
    expect(b.save).toHaveBeenCalledWith('second', [], undefined);
  });
});


it('migrates legacy IDs consistently across reload, mapping, and persistence', async () => {
  const data = new Map<string, string>([
    ['better-writer:draft', 'hello'],
    ['better-writer:annotations', JSON.stringify([{ start: 0, end: 5, fragment: 'hello', question: 'Why?', ts: 1 }])],
  ]);
  const memory = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const first = new DocumentSession(new LocalStorageDraftStore(memory));
  const second = new DocumentSession(new LocalStorageDraftStore(memory));
  sessions.push(first, second);
  await Promise.all([first.load(), second.load()]);
  const id = first.snapshot.notes[0].id;
  expect(second.snapshot.notes[0].id).toBe(id);
  first.edit('xhello'); await first.flush();
  const third = new DocumentSession(new LocalStorageDraftStore(memory)); sessions.push(third);
  await third.load();
  expect(third.snapshot.notes[0]).toMatchObject({ id, start: 1, end: 6 });
});

it('rejects evidence older than the bounded change history', async () => {
  const document = session(); await document.load();
  const captured = document.capture();
  for (let i = 0; i < 1001; i++) document.edit(document.snapshot.draft + 'x');
  expect(document.add(makeNote({ start: 0, end: 5, fragment: 'hello' }, 'Why?'), captured)).toBe(false);
});
