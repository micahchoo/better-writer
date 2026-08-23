# Better Window Cutting

## §1 Goal

The coach cuts every ask along section boundaries within a character budget,
through one shared window constructor, so each question grounds on coherent,
right-sized text and sweep results say how many regions were skipped.

## §2 Architecture Context

Live window pipeline today (all verified 2026-08-22):

- `web/text-window.ts` — `splitBlocks` parses markdown into offset-tracked
  blocks (blank line ends a block; headings are always their own block;
  list-marker lines start items with lazy continuation). `buildAskWindow`
  joins block texts with `\n\n` and wraps one block in
  `[CURSOR START]\n…\n[CURSOR END]`. `markFullDraft`, `findCursorEnvelope`,
  and `AskWindow` are dead code: zero non-test callers.
- `web/coach-sweep.ts` — `planSweep` strides 3 blocks (`WINDOW_BLOCKS = 3`)
  ignoring headings. Its docstring claims the tail merges into the last
  window; the code emits a stub window for tails of 1–2 blocks
  (test pins `[6-8], [9]`). Docstring and code disagree; this plan decides
  behavior, see Q4. `runSweep` passes the window's `startOffset` to
  `extractAnchor` although the question grounds on the marked middle block;
  tie-breaks bias toward the wrong end. Critically, `runSweep` RE-DERIVES
  window bounds by striding `WINDOW_BLOCKS` again (`coach-sweep.ts:171–178`,
  keyed on each window's `startOffset`) instead of trusting the plan — any
  planner change to group sizes must replace this or windows lose their
  bounds entirely and are silently skipped. The UI already renders
  asked/skipped after a sweep (`sweepSummary`, `EditorApp.tsx:616–625`).
- `web/EditorApp.tsx` — `askCursorWindow` rebuilds cursor-centered windowing
  inline (`splitBlocks`, duplicate cursor-block selection, `slice`,
  `buildAskWindow`). The 5 s cadence poll fires it at 30 net-new words +
  20 s pause (`web/cadence.ts`). `sweepDraft` renders per-note progress via
  `onProgress`.
- Consumers read back via fragment search over the FULL draft with a
  nearest-to-cursor tie-break (`web/anchor.ts`), and the server gates output
  against blank-line envelopes derived from the wire payload (`src/gate.ts`).
  Both stay untouched: any windowing change that preserves
  "blocks joined `\n\n` plus markers" remains compatible.

Constraints locked from investigation:

- Q1: no constructed window contains blocks from two different sections.
- Q2: no planned window exceeds `MAX_WINDOW_CHARS` when formed from multiple
  blocks (constant lives once, in `coach-sweep.ts`).
- Q3: a single block larger than the budget is never split mid-block; it is
  emitted as its own oversized window.
- Q4: a trailing group of fewer than 3 blocks merges into the previous
  window unless the merge would break Q2.
- Q5: the dead whole-draft path is deleted and both the module header and
  `CONTEXT.md` describe only live paths.
- Q6: every sweep plan carries an anchor hint that lies inside the marked
  middle block, plus the window's own block bounds consumed directly by
  `runSweep` (no second derivation of grouping anywhere).
- Q7: post-sweep asked/skipped summary already ships
  (`EditorApp.tsx:616–625`); this plan treats it as a regression guard,
  not new work.

## §3 File Structure

Responsibility → file:

- Block parsing, section partitioning, cursor-window selection →
  `web/text-window.ts`
- Sweep planning under section + budget rules → `web/coach-sweep.ts`
- Auto-ask construction (thin caller, zero own logic) → `web/EditorApp.tsx`
- Public language entry for Text Window → `CONTEXT.md`

New exports: `partitionSections`, `cursorWindow` (both in
`web/text-window.ts`). Deleted exports: `markFullDraft`,
`findCursorEnvelope`, `AskWindow`.

## §4 Tasks

### Task W0-a — Partition sections (text-window.ts)

- Files: Modify `web/text-window.ts`, `web/text-window.test.ts`.
- Steps:
  1. Add `export function partitionSections(blocks: Block[]): Block[][]`.
     A heading block OR a thematic-break line (`---`, `***`, `___` —
     CONTEXT.md calls both section boundaries) starts a new section;
     everything after belongs to that section until the next boundary.
     Blocks before the first boundary form their own section.
     Order- and adjacency-preserving.
  2. Tests: empty input → `[]`; heading mid-list starts a section;
     pre-heading intro paragraph is its own section; consecutive headings
     each open a section; a thematic break splits like a heading;
     offsets untouched.
- Verify: `npx vitest run web/text-window.test.ts`

### Task W0-b — Shared cursor window selector (text-window.ts)

- Files: Modify `web/text-window.ts`, `web/text-window.test.ts`.
- Steps:
  1. Add
     `export function cursorWindow(blocks: Block[], caretOffset: number): { texts: string[]; markIndex: number } | null`
     implementing the existing rule: block containing the caret (inclusive
     end), else next block, else last block; null when `blocks` is empty.
     Return the caret-centered slice (±1, edge-clipped) with the cursor
     block's index within the slice as `markIndex`. This moves the exact
     logic now inlined in `EditorApp.tsx` lines 266–281.
  2. Tests pin: caret in gap → next block centered; caret past end → last
     block, window biased backward; first/last block edge clipping.
- Verify: `npx vitest run web/text-window.test.ts`

### Task W1-a — Section-aware, budgeted sweep planning (coach-sweep.ts)

Depends on W0-a.

- Files: Modify `web/coach-sweep.ts`, `web/coach-sweep.test.ts`.
- Steps:
  1. Add `MAX_WINDOW_CHARS = 1200` (single definition).
  2. Rewrite `planSweep`: `partitionSections`, then per section greedily
     group consecutive blocks: stop growing a window at 3 blocks OR when
     adding the next block pushes projected marked length past
     `MAX_WINDOW_CHARS` (sum of block texts + `2 × (n−1)` separators + 26
     marker characters).
  3. Post-pass for Q4: if the final group holds fewer than 3 blocks and
     merging it into the previous window stays within
     `MAX_WINDOW_CHARS`, merge; otherwise keep the stub. This makes the
     docstring true (current code + test encode a stub).
  4. Extend `SweepWindowPlan` with two fields computed here where real
     offsets exist: `cursorHint: number` — the offset of the midpoint of
     the MARKED block inside the full draft
     (`block.start + Math.floor(block.text.length / 2)`) — and
     `bounds: { start: number; end: number }` — first-block start through
     last-block end of THIS window.
- Tests to add/update: a heading between paragraphs forces two plans even
  though a 3-stride would bridge it; an over-budget paragraph becomes a
  single-block window without splitting; tail of 10 short blocks merges
  into the prior window; `cursorHint` lies within the marked block's span;
  every plan entry's `bounds` exactly covers its own blocks; existing
  no-heading fixtures keep stable windows under the new grouping.
- Verify: `npx vitest run web/coach-sweep.test.ts`

### Task W1-b — Consume the hint + delete dead paths (text-window.ts, coach-sweep.ts)

Depends on W1-a. Single agent edits all listed files serially.

- Files: Modify `web/coach-sweep.ts`, `web/text-window.ts`,
  `web/text-window.test.ts`, `web/EditorApp.tsx`, `CONTEXT.md`.
- Steps:
  1. In `runSweep`, stop re-deriving grouping: DELETE the
     `boundsByStart` map and its stride loop (`coach-sweep.ts:171–178`)
     and use `window.bounds` for the containment check at line 213;
     pass `window.cursorHint` instead of `startOffset` to `extractAnchor`
     at line 211. Tests: variable-size plans (heading-split, merged tail)
     all resolve bounds; ties resolve to the anchor nearest the marked
     block for twin paragraphs at a window's two ends.
  2. Delete `markFullDraft`, `findCursorEnvelope`, `AskWindow`, and their
     tests. Delete `findCursorBlock` only if unreferenced after step 3
     (check: `grep -c findCursorBlock web src` — expected 0).
  3. Rewire `askCursorWindow` in `EditorApp.tsx`: replace the inline block
     selection and slicing (lines 258–281) with
     `splitBlocks(text)` → `cursorWindow(blocks, caretOffset)` →
     `buildAskWindow(win.texts, win.markIndex)`. Caret fallback
     (`cursor?.offset ?? midpoint`) stays.
  4. Update `text-window.ts` module header (drop the markFullDraft
     description) and `CONTEXT.md`'s Text Window entry: window = cursor
     block ± neighbors, cut by sweep plan (sections + budget), never a
     whole draft.
- Verify: `npx vitest run && npm run typecheck`
  (no stray references survive: `npm run typecheck` fails on dangling
  imports; additionally `grep -rn markFullDraft web src` → 0 hits)


## §5 Execution Waves
```
Wave 0: W0-a, W0-b            (parallel; different regions of
                               text-window.ts — coordinate: same file)
Wave 1: W1-a                  (depends W0-a)
        W1-b                  (depends W1-a, same file chain — SERIAL)

W0-a and W0-b touch one file; assign both to one agent in sequence rather
than racing them.
```

## §6 Open Questions

1. Is `MAX_WINDOW_CHARS = 1200` right for the target local model's prompt?
   Needs one measure: token estimate of largest healthy ask vs model
   context. Constant is single-sourced; tune later.
2. Oversized single block (Q3) currently sails through ungated — the model
   sees a huge partial-context ask. Acceptable v1? Alternative: skip such
   blocks in sweeps and count them in `skipped` — needs a writer-visible
   reason why a huge paragraph got nothing.
3. Overlap policy (one-block look-back across windows) remains a deferred
   product decision; doubling cost is not worth it before measuring the
   fallback rate from `/ask` logs (`{seed_id, failures[], fallback}`).

## §7 Artifact Manifest

Modified: `web/text-window.ts`, `web/text-window.test.ts`,
`web/coach-sweep.ts`, `web/coach-sweep.test.ts`, `web/EditorApp.tsx`,
`CONTEXT.md`.
Created: none. Deleted symbols: `markFullDraft`, `findCursorEnvelope`,
`AskWindow`, `AskWindow` tests, possibly `findCursorBlock` (becomes
private-but-used or deleted per W1-b step 2).

## §8 Verification

Per-wave:

- Wave 0: `npx vitest run web/text-window.test.ts`
- Wave 1: `npx vitest run web/coach-sweep.test.ts && npm run typecheck`
- Final: `npm test && npm run typecheck`

Behavioral proof beyond unit tests: sweep the sample draft in a dev server
against `/tmp/bw-smoke` isolation (NEVER against the live 4517 origin —
`/save` clobbers `data/drafts/current.md`) and confirm: no highlight spans
two sections; total asks match the plan; the existing
asked/skipped summary still renders after the refactor (Q7 regression).

## §9 Q-Reference Summary

| ID | Constraint |
|----|------------|
| Q1 | Windows never span sections |
| Q2 | Multi-block windows ≤ MAX_WINDOW_CHARS |
| Q3 | Blocks never split mid-way; oversize = own window |
| Q4 | Tail merges into prior window unless Q2 forbids |
| Q5 | Dead whole-draft path deleted; docs updated |
| Q6 | Anchor hint sits inside the marked middle block |
| Q7 | Asked/skipped summary keeps rendering (existing UI) |


## Assumptions to re-verify at review gates

1. `gate.ts` echo retargeting works on any payload carrying exactly one
   START/END pair — holds because window assembly format is unchanged.
2. Anchor tier search runs over the full draft, so shrinking windows cannot
   orphan anchoring — verified in `web/anchor.ts` today.
3. Persisted annotations store draft offsets, not window indices — window
   changes cannot invalidate saved notes.
4. `askCursorWindow`'s comment "like runSweep's windows" becomes literally
   true only via the shared constructor — after W0-b/W1-b the shapes agree
   by construction, not by prose.
5. The post-sweep summary lives on component state fed from `SweepResult`;
   W1-b keeps `runSweep`'s return shape untouched, so the UI survives.
   Review gate check: `grep -n sweepSummary web/EditorApp.tsx` → state,
   setter, clear-on-sweep, render all intact after W1-b.

## Alternatives Considered

- Hard-split oversized blocks at sentence boundaries mid-block → rejected:
  fragments anchor on partial sentences and grounding checks lose whole-
  sentence bigrams; violates the block invariant everywhere downstream (Q3).
- Token-count budgets via a tokenizer dependency → rejected: adds a
  dependency for a proxy that character counts approximate well enough at
  this scale; revisit only if open question 1 measures a real overflow.
- Keep stride-3 and merely reorder groups at headings → rejected: leaves
  budget unbounded, the sharpest failure mode.
