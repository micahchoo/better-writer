import type { Annotation } from '../src/core/types';
export type DraftStorage = 'browser' | 'server';

/** A pinned note on screen — the wire contract's Annotation under its domain name. */
export type Note = Annotation;

/**
 * A highlight the coach's question was anchored to, with the draft offsets
 * it covered at the time the question was asked. Alias of Note (Annotation);
 * note identity and minting live in notes.ts.
 */
export type AnchorRecord = Annotation;

export interface DraftStore {
  load(): Promise<string>;
  save(draft: string, notes?: Note[], opts?: { keepalive?: boolean }): Promise<void>;
  loadAnnotations(): Promise<Note[]>;
}

const STORAGE_KEY = 'better-writer:draft';
const ANNOTATIONS_KEY = 'better-writer:annotations';
const SNAPSHOT_KEY = 'better-writer:document';

/**
 * Per-item shape guard mirroring the server's parseAnnotation rigor: a note
 * is valid only when every required field exists with the right type and the
 * offsets form a finite, positive span. Malformed entries are skipped, never
 * allowed to sail through loadAnnotations as garbage.
 */
function parseNote(value: unknown): Note | null {
  if (typeof value !== 'object' || value === null) return null;
  const a = value as Record<string, unknown>;
  if (typeof a.start !== 'number' || typeof a.end !== 'number') return null;
  if (typeof a.fragment !== 'string' || typeof a.question !== 'string') return null;
  if (typeof a.ts !== 'number') return null;
  if (
    !Number.isFinite(a.start) ||
    !Number.isFinite(a.end) ||
    !Number.isInteger(a.start) ||
    !Number.isInteger(a.end) ||
    a.start < 0 ||
    a.end <= a.start
  ) {
    return null;
  }
  const out: Note = {
    start: a.start,
    end: a.end,
    fragment: a.fragment,
    question: a.question,
    ts: a.ts,
  };
  if (typeof a.id === 'string' && a.id.length > 0) out.id = a.id;
  if (a.source !== undefined) {
    if (a.source !== 'seed' && a.source !== 'reshaped' && a.source !== 'topic-probe') return null;
    out.source = a.source;
  }
  // Optional and advisory: context only disambiguates a duplicate fragment
  // (H9-1), so a malformed value is dropped, never a reason to reject a note.
  const ctx = a.context;
  if (typeof ctx === 'object' && ctx !== null) {
    const { before, after } = ctx as Record<string, unknown>;
    if (typeof before === 'string' && typeof after === 'string') out.context = { before, after };
  }
  return out;
}

function sanitizeNotes(value: unknown): Note[] {
  if (!Array.isArray(value)) return [];
  const out: Note[] = [];
  for (const item of value) {
    const parsed = parseNote(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/** Draft and annotations commit in one localStorage operation. Legacy keys remain readable. */
export class LocalStorageDraftStore implements DraftStore {
  private loaded?: { draft: string; notes: Note[] };
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage) {}

  private readSnapshot(): { draft: string; notes: Note[] } {
    try {
      const raw = this.storage.getItem(SNAPSHOT_KEY);
      if (raw) {
        const value = JSON.parse(raw);
        if (value?.version === 1 && typeof value.draft === 'string') {
          return { draft: value.draft, notes: sanitizeNotes(value.annotations) };
        }
      }
    } catch { /* Fall back to legacy data if the new snapshot is unreadable. */ }
    let draft = '', notes: Note[] = [];
    try { draft = this.storage.getItem(STORAGE_KEY) ?? ''; } catch { /* storage unavailable */ }
    try {
      const raw = this.storage.getItem(ANNOTATIONS_KEY);
      if (raw) notes = sanitizeNotes(JSON.parse(raw));
    } catch { /* corrupt legacy notes */ }
    return { draft, notes };
  }

  async load(): Promise<string> {
    this.loaded = this.readSnapshot();
    return this.loaded.draft;
  }

  async save(draft: string, notes?: Note[], _opts?: { keepalive?: boolean }): Promise<void> {
    const snapshot = { draft, notes: notes ?? (this.loaded ?? this.readSnapshot()).notes };
    // setItem is atomic: quota failure retains the previous complete snapshot.
    // Preserve legacy keys as a fallback; successful saves migrate by precedence.
    this.storage.setItem(SNAPSHOT_KEY, JSON.stringify({ version: 1, draft, annotations: snapshot.notes }));
    this.loaded = snapshot;
  }

  async loadAnnotations(): Promise<Note[]> {
    return (this.loaded ?? this.readSnapshot()).notes;
  }
}

export class ServerDraftStore implements DraftStore {
  private readonly endpoint: string;
  /** Last draft the server is known to hold — the anchor notes are persisted
   * against without a read-back round-trip. The caller keeps draft and notes
   * in step (EditorApp always follows a note change with a draft save
   * carrying the same notes), so this never desyncs the server. */
  private draft = '';
  /** Last notes the server is known to hold (from the most recent /load or /save). */
  private notes: Note[] = [];

  constructor(endpoint = '') {
    this.endpoint = endpoint;
  }

  async load(): Promise<string> {
    const data = await this.fetchLoad();
    this.draft = data.draft ?? '';
    this.notes = sanitizeNotes(data.annotations ?? []); // forward-compat: older /load payloads omit annotations
    return this.draft;
  }

  async save(draft: string, notes?: Note[], opts?: { keepalive?: boolean }): Promise<void> {
    // Shared seam semantic (mirrors LocalStorageDraftStore): omitted notes
    // KEEP the existing annotation list. /save always carries a full list, so
    // when the caller omits notes we ride the last-known list cached from
    // /load or a prior /save — never wipe.
    const annotations = notes ?? this.notes;
    const url = `${this.endpoint}/save`;
    const body = JSON.stringify({ draft, annotations });
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        ...(opts?.keepalive ? { keepalive: true } : {}),
      });
    } catch (err) {
      if (!opts?.keepalive) {
        throw err;
      }
      // Chrome rejects a keepalive fetch when the body exceeds the 64 KiB
      // cap; retry once without keepalive so the save still lands.
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    }
    if (!res.ok) {
      throw new Error(`Draft save failed: ${res.status} ${res.statusText}`);
    }
    this.draft = draft;
    this.notes = annotations;
  }

  async loadAnnotations(): Promise<Note[]> {
    return this.notes;
  }

  private async fetchLoad(): Promise<{ draft?: string; annotations?: Annotation[] }> {
    const res = await fetch(`${this.endpoint}/load`);
    if (!res.ok) {
      throw new Error(`Draft load failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as { draft?: string; annotations?: Annotation[] };
  }
}

export function makeDraftStore(storage: DraftStorage): DraftStore {
  return storage === 'server' ? new ServerDraftStore() : new LocalStorageDraftStore();
}
