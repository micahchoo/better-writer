/**
 * inbox-panel: the pinned-questions tray — every coach note the writer has
 * anchored, newest last (array order, matching the editor's chronological
 * reading), each row offering to jump the editor back to its span or to
 * resolve (dismiss) the note.
 *
 * The tray is purely presentational: it owns no note state and fires no
 * mutations itself. Focus requests and resolutions flow up through
 * onFocusNote / onResolveNote, and the actual reveal (an editor scroll jump)
 * is owned by the caller via focusNoteId. Keeping identity external also lets
 * the sibling sweep re-mount this list freely — a note's React key is its
 * noteId (the start:end:ts triple from notes.ts), so re-renders never lose a
 * row's open state.
 */

import type { AnchorRecord } from './draft-store';
import { noteId } from './notes';

export interface InboxPanelProps {
  notes: AnchorRecord[];
  /** Externally controlled (editor scroll-jump target); informational here. */
  focusNoteId: string | null;
  /** Request to reveal the note's span in the editor. */
  onFocusNote(note: AnchorRecord): void;
  /** Request to resolve (dismiss) the note. */
  onResolveNote(note: AnchorRecord): void;
}

export function InboxPanel(props: InboxPanelProps): JSX.Element {
  const { notes, focusNoteId, onFocusNote, onResolveNote } = props;

  if (notes.length === 0) {
    // Quiet empty state: the tray collapses to a single muted line so an
    // empty panel never competes with the draft for attention.
    return <p className="inbox-empty">No pinned questions.</p>;
  }

  return (
    <div className="inbox-panel" role="list" aria-label="Pinned questions">
      {notes.map((note) => (
        <div
          key={noteId(note)}
          className="inbox-row"
          role="listitem"
          onClick={() => onFocusNote(note)}
        >
          {/* Row identity: the question itself, in the coach's serif voice. */}
          <p className="inbox-question">{note.question}</p>
          {/* The anchor text the question was grounded on — muted mono,
              ellipsized to a single line (truncation is styled in CSS). */}
          <span className="inbox-fragment">{note.fragment}</span>
          <button
            type="button"
            className="coach-resolve"
            aria-label="Mark resolved"
            // Resolution must not also focus the note: stop propagation so
            // the row-body click handler above never sees the dismiss.
            onClick={(e) => {
              e.stopPropagation();
              onResolveNote(note);
            }}
          >
            Resolved
          </button>
        </div>
      ))}
    </div>
  );
}
