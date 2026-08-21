/**
 * editor-access: the ONE adapter for cursor-read and dictation-insert.
 *
 * Surface note: @uiw/react-md-editor v4.x (installed: 4.1.2) does NOT use
 * CodeMirror 6 — its package has no @codemirror/* dependency and the editor
 * is a controlled `<textarea class="w-md-editor-text-input">` (see
 * node_modules/@uiw/react-md-editor/esm/components/TextArea/Textarea.js).
 * There is therefore no `.cm-editor` / EditorView.findFromDOM path to take;
 * the textarea IS the editing surface and the documented fallback in the
 * design contract is the primary implementation here.
 *
 * The textarea is reached two ways, in order:
 *   1. via the MDEditor ref — the ref exposes `ContextStore.textarea`
 *      (the element react-md-editor itself stores on mount);
 *   2. via a DOM query for `.w-md-editor-text-input`.
 *
 * insertAtCursor uses the native value setter + a bubbling `input` event so
 * the controlled React component picks the change up, then restores the
 * caret to just past the inserted text.
 */

export interface CursorPosition {
  /** Character offset of the caret in the full editor text. */
  offset: number;
  /** The full editor text. */
  text: string;
}

export interface EditorAccess {
  /** Caret position + full document text, or null when no editor is mounted. */
  readCursor(): CursorPosition | null;
  /** Insert `text` at the caret, replacing any selection. Returns false if the editor is unmounted. */
  insertAtCursor(text: string): boolean;
}

export interface EditorAccessOptions {
  /** Optional supplier of the textarea from the MDEditor ref. */
  getTextarea?: () => HTMLTextAreaElement | null;
}

const TEXTAREA_SELECTOR = '.w-md-editor-text-input';

export function createEditorAccess(options: EditorAccessOptions = {}): EditorAccess {
  const findTextarea = (): HTMLTextAreaElement | null => {
    const fromRef = options.getTextarea?.();
    if (fromRef) return fromRef;
    return document.querySelector<HTMLTextAreaElement>(TEXTAREA_SELECTOR);
  };

  return {
    readCursor(): CursorPosition | null {
      const textarea = findTextarea();
      if (!textarea) return null;
      return { offset: textarea.selectionStart ?? textarea.value.length, text: textarea.value };
    },

    insertAtCursor(text: string): boolean {
      const textarea = findTextarea();
      if (!textarea) return false;

      textarea.focus({ preventScroll: true });
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      const next = textarea.value.slice(0, start) + text + textarea.value.slice(end);

      // Bypass React's value tracker so the controlled component re-renders.
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(textarea, next);
      } else {
        textarea.value = next;
      }
      const caret = start + text.length;
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
  };
}
