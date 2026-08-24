# Editor forked from Buffertab; storage replaced; one editor-access seam

> **Superseded:** the textarea substrate described below was replaced by a
> CodeMirror 6 `EditorView` behind the same `editor-access` seam — see
> [0008-cm6-editor-substrate](0008-cm6-editor-substrate.md). This record is
> retained as history of the Buffertab fork and storage decision only.

Better-writer's editor is forked from Buffertab (MIT): a React wrapper over `@uiw/react-md-editor`. Buffertab's URL-hash storage is removed in favor of a server-backed Markdown file (`data/drafts/current.md`). Reading the cursor (for the text window) and inserting dictation both go through a single `editor-access` adapter over the editor's textarea — react-md-editor is textarea-based (verified: v4.1.2 has no CodeMirror dependency), so the cursor is `selectionStart`/`selectionEnd`, not a CM6 `EditorView`.
