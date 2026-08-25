/**
 * draft-store: the DraftStore seam — two adapters behind one interface.
 *
 *   LocalStorageDraftStore — drafts live in the browser (static demo).
 *   ServerDraftStore       — drafts live on the local server (POST /save,
 *                            GET /load), so the writer's prose is never
 *                            stuck in one machine's browser.
 *
 * Both adapters expose the same persistence contract: the draft plus the
 * pinned notes it carries (the coach's question-anchors). The browser store
 * keeps notes under their own localStorage key; the server adapter persists
 * them too, because the wire contract carries them — GET /load returns
 * {draft, annotations} and POST /save accepts {draft, annotations}, so notes
 * survive alongside the prose on the server.
 *
 * The two adapters share one semantic for omitted notes: `save(draft)` with
 * no notes KEEPS the existing annotation list. The browser store leaves the
 * annotations key untouched; the server rides the last-known list (cached
 * from /load or a prior /save) instead of wiping — no read-back round-trip is
 * ever needed to keep draft and notes in step.
 */

import type { Annotation } from '../src/types';
import type { CoachMode } from './coach';

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

export class LocalStorageDraftStore implements DraftStore {
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>;

  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage) {
    this.storage = storage;
  }

  async load(): Promise<string> {
    try {
      return this.storage.getItem(STORAGE_KEY) ?? '';
    } catch {
      return ''; // storage disabled (private mode): start empty
    }
  }

  async save(draft: string, notes?: Note[], _opts?: { keepalive?: boolean }): Promise<void> {
    // Shared seam semantic: omitted notes keep the existing annotation list —
    // `save(draft)` with no notes leaves the annotations key untouched. opts
    // (keepalive) is a no-op: sync setItem needs nothing.
    //
    // No soft-fail: a QuotaExceededError (or any storage failure) REJECTS so
    // the SaveCoordinator's failure/retry path counts it and surfaces a
    // persistent error once storage fails twice — the writer is told the
    // draft did not land, not silently left with a 'Saved' stamp.
    this.storage.setItem(STORAGE_KEY, draft);
    if (notes !== undefined) this.storage.setItem(ANNOTATIONS_KEY, JSON.stringify(notes));
  }

  async loadAnnotations(): Promise<Note[]> {
    try {
      const raw = this.storage.getItem(ANNOTATIONS_KEY);
      if (!raw) return [];
      return sanitizeNotes(JSON.parse(raw));
    } catch {
      return []; // storage disabled or corrupt payload: start empty
    }
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

export function makeDraftStore(mode: CoachMode): DraftStore {
  return mode === 'local' ? new ServerDraftStore() : new LocalStorageDraftStore();
}
