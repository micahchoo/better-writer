# CodeMirror 6 Migration Implementation Plan

> **For agentic workers:** Use executing-plans-style task contracts below. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the textarea substrate (`@uiw/react-md-editor`) with CodeMirror 6 so highlights become native decorations and per-key cost drops from O(doc) to O(paragraph).

**Architecture:** All editor access stays behind the single `web/editor-access.ts` seam, deepened from 2 methods to 5 (readCursor, insertAtCursor, replaceDocument, scrollToOffset, rectForRange). Callers never see an `EditorView`. Mount CodeMirror directly from `@codemirror/*` packages (no `@uiw/react-codemirror` wrapper — see Alternatives). Highlights become derived state: React annotations remain the single source of truth; a pure builder turns them into a `DecorationSet` each time they change. Nothing in CM6 incrementally maps positions independently.

**Tech Stack:** `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/commands`, `@codemirror/lang-markdown`; React 18; vite; vitest.

---

## Constraints (minted here; no docs/decisions/ registry exists yet)

- **C1 (single-writer):** Every byte entering the buffer goes through `EditorAccess`. No caller touches a ref, DOM node, or `EditorView`.
- **C2 (derived marks):** Decoration ranges are rebuilt from reconciled annotations on every change; CM6 never owns highlight state across transactions.
- **C3 (history policy lives in the seam):** `replaceDocument(text)` dispatches with `Transaction.addToHistory.of(false)` (events map across it). Sample-load passes `{ history: 'reset' }` semantics by recreating state via the mount, not a transaction. User typing always records history.
- **C4 (composition safety):** `insertAtCursor` and `replaceDocument` return false / no-op early when `view.composing` is true. Dictation retries are acceptable; dropped mid-composition insertions are not.
- **C5 (behavioral parity):** After migration: typing, sweep-note highlights + popover, click-open popover, reload persistence (localStorage + server), dictation insertion, sample-draft load, genre selector, BYOK flows all behave as before. Preview-pane behavior characterized before removal and matched or consciously dropped with user sign-off.

## Alternatives Considered

1. **Stay on MDEditor, enrich the mirror** — rejected: v4 exposes no marks escape hatch (verified: full `Types.ts` prop surface has none); every new overlay costs more mirror geometry; runtime measured O(doc)/key (~82 ms p50 at 100 KB).
2. **Migrate via `@uiw/react-codemirror` wrapper** — rejected: its controlled-value sync dispatches full-doc replacements *without* `addToHistory:false` (source-verified in `useCodeMirror.ts`) and defers/drops updates during typing via a 200 ms latch — exactly the semantics C1/C3 forbid us to inherit. Direct packages give one less adapter and total control.
3. **Chosen: direct `@codemirror/*` + deepened seam** — one React host component in `EditorApp`, all CM6 knowledge inside `editor-access.ts`.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | swap deps |
| `web/editor-access.ts` | THE seam: 5-method interface over `EditorView` (C1, C3, C4) |
| `web/editor-access.test.ts` | headless seam tests (real `EditorState`, fake-less) |
| `web/codemirror-host.tsx` | ~40-line React host: creates/mounts `EditorView`, owns nothing else |
| `web/decorations.ts` | pure builder: `(anchors, docLength) → DecorationSet` + StateField effect wiring |
| `web/decorations.test.ts` | headless builder tests |
| `web/EditorApp.tsx` | consumes seam only; loses MDEditor import, textarea refs, scrollTop math |
| `web/highlight.tsx` | shrinks to popover React component positioned via `rectForRange` |
| `web/style.css` | remove `.w-md-editor-*` coupling; CM6 theme via `EditorView.theme` inside host |
| `docs/adr/0008-cm6-editor-substrate.md` | supersedes ADR 0003's textarea note |

---

### Task 1: Dependency swap — [CHANGE SITE]

**Orient:** Without CM6 packages installed nothing downstream compiles; without removing md-editor at the END we'd risk half-built states shipping.
**Files:** Modify `package.json`.

- [ ] Add `@codemirror/state @codemirror/view @codemirror/language @codemirror/commands @codemirror/lang-markdown`
- [ ] Do NOT remove `@uiw/react-md-editor` yet (still imported until Task 5)
- [ ] Run: `npm install && npx tsc --noEmit` — Expected: clean (types resolve)

### Task 2: Seam rewrite — editor-access over EditorView

**Orient:** Every consumer (cursor read, dictation insert, sample load, note scroll, popover rects, content sync) must work through one small interface for CM6 to be deletable later (deletion test).
**Flow position:** substrate swap node — upstream: React callers; downstream: EditorView.
**Skill:** `tdd`
**Codebooks:** `text-editing-mode-isolation`, `undo-under-distributed-state`

<contracts>
**Interface (downstream):**
```ts
export interface Rect { top: number; bottom: number; left: number; right: number }
export interface CursorPosition { offset: number; text: string }
export interface EditorAccess {
  attach(target: HTMLElement, initialText: string, onDocChange: (text: string, transactions: readonly Transaction[]) => void): void
  detach(): void
  readCursor(): CursorPosition | null
  insertAtCursor(text: string): boolean          // false when unattached or composing (C4)
  replaceDocument(next: string, opts?: { history?: 'exclude' }): void   // C3
  scrollToOffset(offset: number): void
  rectForRange(from: number, to: number): Rect | null
}
```
Behavioral invariant: `attach` owns `focus()`; `onDocChange` fires once per transactions batch containing at least one doc change, AFTER the state is updated.
</contracts>

- [ ] Write `web/editor-access.test.ts` FIRST using a real `EditorView` created against a jsdom element (CM6 works in jsdom for state/dispatch; skip pure-layout assertions)
- [ ] Cases: cursor read; insert replaces selection + returns true; insert during simulated composition returns false; replaceDocument excludes history but maps prior events; sample-load reset semantics; onDocChange batching; rectForRange null when detached
- [ ] Run: `npx vitest run web/editor-access.test.ts` — Expected: PASS
- [ ] Implementation: `createEditorAccess({ getView })` retained shape; move all `Transaction.addToHistory`, `EditorSelection`, `scrollIntoView` handling inside

### Task 3: Host component + EditorApp cutover — [CHANGE SITE]

**Orient:** The app must type, save, and load through the new substrate with no behavior change; this is the wave that makes old MDEditor refs dead code.
**Flow position:** substrate swap — upstream: seam (Task 2); downstream: highlight popover (Task 5).
**Skill:** `none` (integration)

- [ ] Create `web/codemirror-host.tsx`: mounts view via `editorAccess.attach(div, initialText, cb)`, applies `EditorView.theme` matching current prose styles (font, line-height, padding — copy computed values from `.w-md-editor-text-input` rules in `style.css:78-80` BEFORE deleting them)
- [ ] `EditorApp.tsx`: replace `<MDEditor>` with host; delete `overlayTextareaRef` synthesis; `editorAccess` built with `getView` closure over host; sample-load button calls `replaceDocument(SAMPLE_DRAFT)`; dictation keeps calling `insertAtCursor` (unchanged call site); `handleContentChange` fed from `onDocChange`
- [ ] Preserve: `autoFocus`, focus-on-mount timing, Escape/close paths untouched
- [ ] Verify interim: `npx tsc --noEmit && npx vitest run` — Expected: green except `highlight.test.tsx` (known-broken until Task 5; quarantine with `it.skip` + TODO(Task 5), do NOT delete)
- [ ] Manual smoke NOW (pre-highlight breakage is known): serve `/tmp/bw-smoke` copy per live-server rule, BW_PORT≠4517; typing + sample load + persistence reload work
- [ ] **Characterize preview:** screenshot current dist `preview="live"` surface first; record whether users see a rendered-markdown pane; write finding into ADR 0008 draft (decides C5 parity scope)

### Task 4: Derived decorations module (parallel-safe)

**Orient:** Highlights must exist as data before Task 5 wires them visually.
**Flow position:** upstream: `AnchorRecord[]` from draft-store/coach-sweep; downstream: popover + EditorView.decorations facet.
**Skill:** `tdd`
**Contracts:** input `Array<{start:number,end:number,tone:string}>` offsets guaranteed remapped by existing `reconcileAnnotations`; output `RangeSet<Decoration>` sorted, non-overlapping-or-nested-legal.

- [ ] Create `web/decorations.ts`: `buildHighlightSet(spans, docLength): DecorationSet`; `highlightExtension(): Extension` exposing a `StateEffect` to push fresh sets; StateField stores + serves via `EditorView.decorations`
- [ ] Tests FIRST in `web/decorations.test.ts`: empty spans → empty set; spans beyond docLength clamped; sorted order enforced; effect round-trip through `EditorState.create().update()`
- [ ] Run: `npx vitest run web/decorations.test.ts` — Expected: PASS

### Task 5: Overlay cutover — decorations + popover + scroll

**Orient:** Delete the mirror-div geometry machine; highlights paint natively, popover follows via coordinates, notes scroll via offset.
**Flow position:** highlight pipeline — upstream: decorations module (Task 4); downstream: user-visible sweep flow.
**Codebooks:** `virtualization-vs-interpolation-fidelity` gap noted if popover jitters on scroll.

- [ ] EditorApp feeds reconciled anchors → effect → decorations on every annotations/draft change (C2: derived, never incrementally mapped)
- [ ] Popover: `rectForRange(anchor.start, anchor.end)` positions the existing popover component; re-position on view update events (doc change + geometry) — subscribe via update listener in host, expose event to React
- [ ] `handleFocusNote` → `editorAccess.scrollToOffset(note.start)`; delete line-height/scrollTop math
- [ ] `highlight.tsx`: remove mirror div, scroll translation, ResizeObserver; un-skip `highlight.test.tsx`, rewrite around rectForRange/popover logic
- [ ] CSS: remove `.coach-highlight-*` mirror dependencies & `.w-md-editor-*` overrides no longer served
- [ ] Run: `npx vitest run && npx tsc --noEmit` — Expected: full suite green

### Task 6: Removal, parity, docs — [CHANGE SITE]

**Orient:** Clean cutover: dead dependency and styles gone; behavior proven equal in an isolated browser cycle.
**Depends on:** Tasks 3–5 verified.

- [ ] Remove `@uiw/react-md-editor` (+ `@uiw/react-markdown-preview` css imports) from `package.json`; rebuild dist (`npm run build`)
- [ ] Bundle audit: gzip size of new dist JS within ~±15% of 205 KB measured target; record actuals in ADR
- [ ] Full E2E smoke in `/tmp/bw-smoke` (NEVER port 4517): type → auto-save persists → reload restores; sweep produces highlighted span + popover opens on click; focus-note scrolls; sample load resets without history pollution (undo after load ≠ wipe document); dictation gated in static mode; byok config save/load flow
- [ ] `docs/adr/0008-cm6-editor-substrate.md`: supersedes 0003's substrate paragraph; records preview-parity decision (from Task 3 characterization) + C1–C5
- [ ] Run: `npx vitest run && npx tsc --noEmit && npm run build` — Expected: all green

---

## Execution Waves

- **Wave 1:** Tasks [1, 4] (parallel) — independent files
- **Wave 2:** Task 2 (serial) — seam contract everything else consumes
- **Wave 3:** Tasks [3] then [5] (serialized — both edit EditorApp.tsx)
- **Wave 4:** Task 6

## Open Questions / Falsifiable Assumptions

Tier: **[B]** blocking, **[E]** exploratory.

- **[B] FA-1:** CM6 `Decoration.mark` inside prose works with jsdom-free headless tests and doesn't hit the closed-but-recent IME-boundary bug family (#1650/#1654). *Falsified if:* smoke shows garbling when highlighting overlaps active typing. Mitigation: marks are derived post-hoc, never mutated mid-transaction.
- **[B] FA-2:** `onDocChange` via update-listener batches satisfy `SaveCoordinator`/annotation-reconcile cadence identically to today's `onChange`. *Falsified if:* save-loop or reconcile tests fail when rewired; regression net = existing coach-sweep + draft-store suites.
- **[B] FA-3:** `rectForRange` popover positioning survives scrolled state and post-re-anchor offsets. *Falsified if:* popover lands detached after windowed content scrolls (viewport virtualization makes far-above-anchor rects null) → fallback: clamp to viewport edge or defer-open until scrolled near.
- **[E] FA-4:** History mapping across `addToHistory:false` replacements feels right in practice (undo never resurrects pre-replace text wholesale). Only empirically checkable in smoke; guide recommends state-recreation for true resets, which sample-load adopts.
- **[E] FA-5:** Theme copy-paste of font metrics reproduces identical visual rhythm (measured parity via screenshot diff of prose area).
- **[E] FA-6:** Mobile keyboard quirks (Android boards) degrade gracefully; desktop-only verification accepted for this pass, flagged in ADR.

### Task-specific

- **Task 2:** Q: does CM6 function fully in jsdom (domobserver needs MutationObserver)? jsdom ≥26 provides it; expected yes — spike-in-test confirms before implementation proceeds. *Marked Blocking.*
- **Task 3:** Q: what exactly does `preview="live"` show users today? Answered by characterization step (screenshot), not assumed.
- **Task 5:** Q: does clicking a marked span still open popovers after CM6 routes clicks? Verified via smoke; widget/mark click handlers if not.

<!-- PLAN_MANIFEST_START -->
| File | Action | Marker |
|------|--------|--------|
| `package.json` | patch | `"@codemirror/lang-markdown"` present, `"@uiw/react-md-editor"` absent (after T6) |
| `web/editor-access.ts` | patch | `scrollToOffset(offset: number): void` |
| `web/editor-access.test.ts` | create | `describe('editor-access'` |
| `web/codemirror-host.tsx` | create | `attach(` |
| `web/decorations.ts` | create | `buildHighlightSet` |
| `web/decorations.test.ts` | create | `buildHighlightSet` |
| `web/EditorApp.tsx` | patch | `codemirror-host` import, zero `MDEditor` references |
| `web/highlight.tsx` | patch | no `w-md-editor-text-pre` references |
| `web/style.css` | patch | no `.w-md-editor-text-input` selectors |
| `docs/adr/0008-cm6-editor-substrate.md` | create | `supersedes` |
<!-- PLAN_MANIFEST_END -->

## Verification Checklist (whole-plan gate)

1. `npx vitest run` full green including rewritten highlight tests.
2. `npx tsc --noEmit` clean.
3. `npm run build` succeeds; bundle gzip recorded vs 352 KB baseline (target ≤ ~215 KB).
4. Isolated-browser E2E checklist in Task 6 executed with screenshots/serving log as proof.
5. No writes touched port 4517 or real `data/drafts/current.md` during any verification.
