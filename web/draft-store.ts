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
 * survive alongside the prose on the server. /save always overwrites the
 * server's annotation list ([] when the caller omits notes), so no read-back
 * round-trip is ever needed to keep the two in sync.
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
  saveAnnotations(notes: Note[]): Promise<void>;
}

const STORAGE_KEY = 'better-writer:draft';
const ANNOTATIONS_KEY = 'better-writer:annotations';

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

  async save(draft: string, _notes?: Note[], _opts?: { keepalive?: boolean }): Promise<void> {
    // The browser store ignores the notes argument: notes persist under their
    // own key via saveAnnotations, never entangled with the draft payload.
    // opts (keepalive) is likewise a no-op here: sync setItem needs nothing.
    try {
      this.storage.setItem(STORAGE_KEY, draft);
    } catch {
      // Quota exceeded or storage disabled: fail soft — the writer keeps typing.
    }
  }

  async loadAnnotations(): Promise<Note[]> {
    try {
      const raw = this.storage.getItem(ANNOTATIONS_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Note[]) : [];
    } catch {
      return []; // storage disabled or corrupt payload: start empty
    }
  }

  async saveAnnotations(notes: Note[]): Promise<void> {
    try {
      this.storage.setItem(ANNOTATIONS_KEY, JSON.stringify(notes));
    } catch {
      // Quota exceeded or storage disabled: fail soft — the highlight is transient.
    }
  }
}

export class ServerDraftStore implements DraftStore {
  private readonly endpoint: string;
  /** Last draft the server is known to hold — the anchor saveAnnotations
   * persists notes against without a read-back round-trip. The caller keeps
   * draft and notes in step (EditorApp always follows a note change with a
   * draft save carrying the same notes), so this never desyncs the server. */
  private draft = '';
  /** Last notes the server is known to hold (from the most recent /load or /save). */
  private notes: Note[] = [];

  constructor(endpoint = '') {
    this.endpoint = endpoint;
  }

  async load(): Promise<string> {
    const data = await this.fetchLoad();
    this.draft = data.draft ?? '';
    this.notes = data.annotations ?? []; // forward-compat: older /load payloads omit annotations
    return this.draft;
  }

  async save(draft: string, notes?: Note[], opts?: { keepalive?: boolean }): Promise<void> {
    const annotations = notes ?? []; // /save always overwrites the server's annotation list
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

  async saveAnnotations(notes: Note[]): Promise<void> {
    await this.save(this.draft, notes);
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
