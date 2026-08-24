# CodeMirror 6 is the editor substrate

The editing surface moved off `@uiw/react-md-editor` onto a direct
`@codemirror/*` stack, mounted through the single `web/editor-access.ts` seam.
This supersedes the textarea-substrate paragraph of ADR 0003 (the fork note
that described cursor reads as `selectionStart`/`selectionEnd` over an MDEditor
textarea): the editor is now a real CM6 `EditorView`, and every caller talks to
the `editor-access` seam, never to a textarea or an `EditorView` directly.

## Why

The old textarea mirror cost grew with the document: highlights were painted
by a parallel mirror div whose geometry was remeasured on every keystroke,
measured O(doc) per key (~82 ms p50 at 100 KB). CM6 renders native mark
decorations, and highlight positions are derived from reconciled React state
and pushed wholesale, so per-key work stays flat regardless of document size.

## Constraint outcomes (C1–C5)

- **C1 (single-writer):** every byte entering the buffer goes through
  `EditorAccess` (`insertAtCursor`, `replaceDocument`, typing via
  `onDocChange`). No caller touches a ref, DOM node, or `EditorView`. Only two
  modules import `@codemirror/*` in app source: `web/editor-access.ts` and
  `web/codemirror-host.tsx` (plus `web/decorations.ts`, a seam-internal module).
- **C2 (derived marks):** decoration ranges are rebuilt from reconciled
  annotations on every change and pushed wholesale via the seam's
  `showHighlights(spans)`; CM6 never owns or incrementally maps highlight state
  across transactions.
- **C3 (history policy in the seam):** `replaceDocument(next)` dispatches with
  `Transaction.addToHistory.of(false)` so prior events map across it; sample
  load uses `{ history: 'reset' }` (state recreated) so no pre-load history
  survives; user typing always records history.
- **C4 (composition safety):** `insertAtCursor` no-ops mid-composition; dropped
  mid-composition insertions are avoided over silent retries.
- **C5 (behavioral parity):** typing, sweep highlights + popover, click-open
  popover, reload persistence (localStorage + server), dictation insertion,
  sample-draft load, genre selector, and BYOK flows behave as before, verified
  in an isolated browser cycle.

## Evidence

- **Bundle:** dist JS gzip measured **231 kB after** the migration vs ~352 kB
  before (pre-migration baseline, `@uiw/react-md-editor` + rehype preview
  stack). Raw 747 kB; gzip 231,498 bytes.
- **Runtime:** per-key typing cost is flat (~9 ms p50) regardless of document
  size, vs the old O(doc) path (~82 ms p50 at 100 KB).

## Preview pane: restored as an opt-in toggle

The old stack rendered a live markdown preview (`preview="live"`) as a second
full-document rehype pass per keystroke. The CM6 migration initially dropped
that pane to keep the typing hot path flat; a follow-up restored it as an
**opt-in single-pane toggle** (a topbar Preview/Edit switch) that swaps the cm
host for the rendered pane in the same layout slot — the editor is hidden
(`display: none`), never unmounted, so the undo stack and caret survive the
round-trip.

- **Renderer:** `react-markdown` + `remark-gfm`, chosen over the old
  `@uiw/react-md-editor` rehype stack and over a `marked` + `DOMPurify`
  pipeline. Escape-by-default means raw HTML in the draft is rendered as
  literal text unless an explicit rehype HTML plugin is added — and none is
  (`no rehype-raw`, no `dangerouslySetInnerHTML`), so a hostile
  `<img src=x onerror=…>` stays inert. The dependency tree is lighter and the
  output is plain React elements, not a dangerously-injected HTML string.
- **Lazy chunking:** the renderer is loaded via `React.lazy` + a dynamic
  `import()`, so `react-markdown`/`remark-gfm` land in a **separate vite
  chunk**, not the main bundle — the main bundle stays flat regardless.
- **Cost is opt-in:** the O(doc) render pass happens only while the pane is
  toggled open. It is absent from the typing hot path entirely, and toggling
  off removes it again.
## Preview pane: tri-mode cycle (off / split / full)

The single-pane toggle grew into a three-state cycle — **off → split →
full → off** — driven by one `previewMode: 'off' | 'split' | 'full'` state in
`EditorApp`:

- **off** — editing full-width, the pre-toggle behavior.
- **split** — the `.editor-wrapper` flips to a flex row; the cm host and the
  rendered pane share the width ~50/50, each scrolling independently, with a
  divider line drawn from the `--border` token. Highlights, the popover, and
  click-delegation **remain active** because the editor is still visible.
- **full** — the host is hidden (`display: none` via `.is-hidden`), never
  unmounted, so the undo stack and caret survive the round-trip. Overlays
  stand down here since the editor is off-screen.

The toggle's label/title names the **next** action (show split preview →
expand preview → back to editing), and `aria-pressed` reflects whether any
preview pane is shown.
**Split is the default**: a fresh load opens side-by-side (`previewMode`
starts at `'split'`, not `'off'`). No persistence — every load starts split
and the writer cycles from there.

### Debounced live rendering in split

Split mode renders **live**, but the markdown renderer is O(doc) and must not
sit in the keystroke path. `web/markdown-preview.tsx` therefore debounces
internally (`PREVIEW_DEBOUNCE_MS = 250`): the editor dispatches a `text` prop
change on every keystroke, while the pane only re-renders after 250 ms of
quiet. The render cost is decoupled from keystrokes — one render per quiet
stretch instead of one per key — at the price of the pane lagging typing by
that window.

### Image containment

Oversized images (e.g. a wide data-URI) must never blow out the pane's
horizontal layout. The pane constrains them to the container with the GitHub
convention — `max-width: 100%; height: auto`, plus block display and a
trailing margin to keep vertical rhythm consistent with paragraphs — so
`scrollWidth` stays at `clientWidth` and the pane never scrolls horizontally.

## Known risks

- CM6's closed-but-recent IME composition boundary bug family (upstream
  #1650/#1654): marks are derived post-hoc and never mutated mid-transaction,
  which avoids the direct trigger, but IME-heavy prose is not exhaustively
  exercised.
- Android keyboard edge cases are untested; mobile is out of scope for this
  pass (desktop-only verification accepted).
