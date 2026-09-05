import type { Annotation } from '../src/core/types';
import type { DraftStore } from './draft-store';
import { SaveCoordinator } from './save-coordinator';
import { mapAnnotation, mapAnnotations, reconcileAnnotations, textChanges, type TextChange } from './annotations';
import { CONTEXT_CHARS, migrateNotes, noteId } from './notes';

export interface DocumentSnapshot {
  id: string;
  revision: number;
  draft: string;
  notes: Annotation[];
  ready: boolean;
}
export interface DocumentSessionOptions {
  onChange?(snapshot: DocumentSnapshot): void;
  onError?(error: unknown): void;
  onSaveState?(phase: 'saving' | 'saved'): void;
}

/** Owns one document and one storage destination for its entire lifetime. */
export class DocumentSession {
  private state: DocumentSnapshot = { id: crypto.randomUUID(), revision: 0, draft: '', notes: [], ready: false };
  private readonly saves: SaveCoordinator;
  private disposed = false;
  private edited = false;
  private loading?: Promise<void>;
  private readonly journal = new Map<number, TextChange[]>();

  constructor(private readonly store: DraftStore, private readonly options: DocumentSessionOptions = {}) {
    this.saves = new SaveCoordinator({
      getStore: () => store,
      onError: error => { if (!this.disposed) options.onError?.(error); },
      onSaveState: phase => { if (!this.disposed) options.onSaveState?.(phase); },
    });
  }

  get snapshot(): DocumentSnapshot { return this.capture(); }
  capture(): DocumentSnapshot {
    return { ...this.state, notes: this.state.notes.map(note => ({ ...note, ...(note.context ? { context: { ...note.context } } : {}) })) };
  }

  load(): Promise<void> {
    return this.loading ??= this.loadInitial();
  }

  private async loadInitial(): Promise<void> {
    try {
      const draft = await this.store.load();
      const notes = await this.store.loadAnnotations();
      if (this.disposed) return;
      if (!this.edited) {
        this.state = { ...this.state, draft, notes: reconcileAnnotations(migrateNotes(notes), draft).valid, revision: this.state.revision + 1 };
      }
    } catch (error) {
      if (!this.disposed) this.options.onError?.(error);
    } finally {
      if (!this.disposed) {
        this.state = { ...this.state, ready: true };
        this.publish();
        if (this.edited) this.saves.edit(this.state.draft, this.state.notes);
      }
    }
  }

  edit(draft: string, changes?: TextChange[]): void {
    if (this.disposed || draft === this.state.draft) return;
    const exactChanges = changes ?? textChanges(this.state.draft, draft);
    this.journal.set(this.state.revision, exactChanges.map(change => ({ ...change })));
    if (this.journal.size > 1000) this.journal.delete(this.journal.keys().next().value!);
    this.edited = true;
    this.state = { ...this.state, draft, revision: this.state.revision + 1, notes: mapAnnotations(this.state.notes, exactChanges) };
    this.publish();
    if (this.state.ready) this.saves.edit(draft, this.state.notes);
  }

  /** Accept asynchronous evidence only if it still belongs to this document. */
  add(note: Annotation, captured: DocumentSnapshot = this.capture()): boolean {
    if (this.disposed || (!this.state.ready && !this.edited) || captured.id !== this.state.id || captured.revision > this.state.revision) return false;
    if (captured.draft.slice(note.start, note.end) !== note.fragment || !note.fragment || note.start < 0 || note.end <= note.start) return false;
    let mapped: Annotation | null = { ...note, id: note.id ?? crypto.randomUUID() };
    for (let revision = captured.revision; revision < this.state.revision; revision++) {
      const changes = this.journal.get(revision);
      if (!changes) return false;
      mapped = mapAnnotation(mapped, changes);
      if (!mapped) return false;
    }
    if (this.state.draft.slice(mapped.start, mapped.end) !== mapped.fragment) return false;
    if (this.state.notes.some(existing => noteId(existing) === noteId(mapped!))) return false;
    mapped.context = {
      before: this.state.draft.slice(Math.max(0, mapped.start - CONTEXT_CHARS), mapped.start),
      after: this.state.draft.slice(mapped.end, mapped.end + CONTEXT_CHARS),
    };
    this.setNotes([...this.state.notes, mapped]);
    return true;
  }

  resolve(note: Annotation | string): void {
    const id = typeof note === 'string' ? note : noteId(note);
    this.setNotes(this.state.notes.filter(existing => noteId(existing) !== id));
  }
  clear(): void { this.setNotes([]); }
  flush(opts?: { keepalive?: boolean }): Promise<void> { return this.saves.flush(opts); }
  dispose(): void { this.disposed = true; this.saves.dispose(); this.journal.clear(); }

  private setNotes(notes: Annotation[]): void {
    if (this.disposed || (!this.state.ready && !this.edited)) return;
    this.state = { ...this.state, notes };
    this.publish();
    if (this.state.ready) void this.saves.persistNow(this.state.draft, notes);
  }
  private publish(): void { this.options.onChange?.(this.capture()); }
}
