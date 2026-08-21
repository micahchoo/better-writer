# Editor forked from Buffertab; storage replaced; one editor-access seam

Better-writer's editor is forked from Buffertab (MIT): a React wrapper over `@uiw/react-md-editor`. Buffertab's URL-hash storage is removed in favor of a server-backed Markdown file (`data/drafts/current.md`). Reading the cursor (for the text window) and inserting dictation both go through a single `editor-access` adapter over the editor's textarea — react-md-editor is textarea-based (verified: v4.1.2 has no CodeMirror dependency), so the cursor is `selectionStart`/`selectionEnd`, not a CM6 `EditorView`.
