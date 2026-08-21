/**
 * draft-store: the DraftStore seam — two adapters behind one interface.
 *
 *   LocalStorageDraftStore — drafts live in the browser (static demo).
 *   ServerDraftStore       — drafts live on the local server (POST /save,
 *                            GET /load), so the writer's prose is never
 *                            stuck in one machine's browser.
 */

import type { CoachMode } from './coach';

export interface DraftStore {
  load(): Promise<string>;
  save(draft: string): Promise<void>;
}

const STORAGE_KEY = 'better-writer:draft';

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
}

export function makeDraftStore(mode: CoachMode): DraftStore {
  return mode === 'local' ? new ServerDraftStore() : new LocalStorageDraftStore();
}
