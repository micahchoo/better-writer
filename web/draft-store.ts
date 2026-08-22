/**
 * draft-store: the DraftStore seam — two adapters behind one interface.
 *
 *   LocalStorageDraftStore — drafts live in the browser (static demo).
 *   ServerDraftStore       — drafts live on the local server (POST /save,
 *                            GET /load), so the writer's prose is never
 *                            stuck in one machine's browser.
 *
 * Both adapters also expose question-anchor persistence. The browser store
 * keeps annotations under their own localStorage key; the server store is a
 * no-op until POST /save learns the annotations payload.
 */

import type { CoachMode } from './coach';

/**
 * A highlight the coach's question was anchored to, with the draft offsets
 * it covered at the time the question was asked.
 */
export interface AnchorRecord {
  /** character offset of the anchor's first character in the draft */
  start: number;
  /** character offset just past the anchor's last character */
  end: number;
  /** the draft text the question was anchored to */
  fragment: string;
  /** the coach's question this anchor came from */
  question: string;
  /** epoch ms when the anchor was created */
  ts: number;
}

export interface DraftStore {
  load(): Promise<string>;
  save(draft: string): Promise<void>;
  loadAnnotations(): Promise<AnchorRecord[]>;
  saveAnnotations(annotations: AnchorRecord[]): Promise<void>;
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

  async save(draft: string): Promise<void> {
    try {
      this.storage.setItem(STORAGE_KEY, draft);
    } catch {
      // Quota exceeded or storage disabled: fail soft — the writer keeps typing.
    }
  }

  async loadAnnotations(): Promise<AnchorRecord[]> {
    try {
      const raw = this.storage.getItem(ANNOTATIONS_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as AnchorRecord[]) : [];
    } catch {
      return []; // storage disabled or corrupt payload: start empty
    }
  }

  async saveAnnotations(annotations: AnchorRecord[]): Promise<void> {
    try {
      this.storage.setItem(ANNOTATIONS_KEY, JSON.stringify(annotations));
    } catch {
      // Quota exceeded or storage disabled: fail soft — the highlight is transient.
    }
  }
}

export class ServerDraftStore implements DraftStore {
  private readonly endpoint: string;

  constructor(endpoint = '') {
    this.endpoint = endpoint;
  }

  async load(): Promise<string> {
    const res = await fetch(`${this.endpoint}/load`);
    if (!res.ok) {
      throw new Error(`Draft load failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { draft?: string };
    return data.draft ?? '';
  }

  async save(draft: string): Promise<void> {
    const res = await fetch(`${this.endpoint}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft }),
    });
    if (!res.ok) {
      throw new Error(`Draft save failed: ${res.status} ${res.statusText}`);
    }
  }

  async loadAnnotations(): Promise<AnchorRecord[]> {
    return []; // POST /save persists the draft only; annotations stay client-side.
  }

  async saveAnnotations(_annotations: AnchorRecord[]): Promise<void> {
    // No-op: the server's /save endpoint accepts the draft only, so there is
    // nowhere to persist annotations until that contract changes.
  }
}

export function makeDraftStore(mode: CoachMode): DraftStore {
  return mode === 'local' ? new ServerDraftStore() : new LocalStorageDraftStore();
}
