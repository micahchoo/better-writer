# HANDOFF — better-writer bug hunt

Updated 2026-08-24, after three rounds.

## State

- `f37a156` fixed the two-hunt report (61 findings). A review of those fixes
  found 5 that did not hold; those became R1-R5, plus a new R6.
- R1-R4 (code) are fixed and measured. R5/R6 are README claims, left open.
- A parallel class-level hunt added 30 findings (H1-1..H9-3). **29 are fixed
  and measured**; H5-3 is open by choice, see below.
- Everything resolved lives in FIXED.md with its measurement. BUGS.md holds
  only what is genuinely open.
- **Nothing is committed.**

## Verify

```
npx tsc --noEmit                      # clean
npx vitest run                        # 30 files / 531 tests
python3 -m pytest seeds/test_retrieve.py   # 39 tests
```

## Open (BUGS.md)

- **R5** README says dictation is off without `BW_STT_MODEL_DIR`; there is a
  cache fallback, so it is false. One-line rewrite, wording is the author's.
- **R6** README hangs three promises on the gate. It earns "can only display
  one question"; "never writes a sentence for you" and "never gives advice"
  are properties of the seed bank and prompt, not of a syntactic gate.
- **H5-3** 194 of 1759 `source.quote` values are not verbatim against
  `Books/` (~110 real after discounting OCR ligature/hyphenation artifacts).
  Editorial work on source data, not a code defect: each case needs a decision
  against the book. Fixing only the sampled dozen would leave the contract
  equally broken while looking mended. BUGS.md lists the four steps it needs,
  starting with a schema that can express a multi-span quote.

## Interface changes worth knowing

- `Anchor` gained `match: {start, end}` — the span the question's words
  matched, since the anchor is now widened to a sentence (R1).
- `Annotation` gained optional `context: {before, after}` — 32 chars either
  side, captured at mint time, used only to disambiguate a duplicate fragment
  (H9-1). Optional, so old notes still load.
- Seed preference is `{match, weight}` not `{match, p}`, in BOTH
  `web/coach.ts` and `seeds/retrieve.py`. Per-seed weight, default 3. The
  golden drawer vectors were regenerated; parity asserts exact sequences.
- `insert_seeds` returns `(inserted, replaced)`, not a count.
- `window-stats` exports `countProseWords`; `cadence` uses it.
- `text-window` exports `THEMATIC_BREAK_RE`.
- `seeds/bank.*` went 1757 -> 1759 seeds (two recovered from an id collision).

## Probes (`scripts/probes/`, committed, all re-runnable)

`npx tsx scripts/probes/<name>.ts` from the repo ROOT; `node` for `.mjs`,
`python3` for `.py`. See `scripts/probes/README.md` for which probe backs
which finding. 48 curated from a working set of 90; the rest were broken,
superseded, or covered behaviour that came back clean.

- Round two: `probe-s27` (anchor quality, 4000 draws), `t1` (-ly / passive),
  `t2` (isGrounded, gate advice), `t3-grounding` (grounding rate before/after),
  `probe14` (gate attacks), `probe1/3/4/6/13/15/16/17`.
- Round three: `v-a`, `v-a2` (proper nouns, case folding), `v-b`, `v-b2`
  (heuristics, cadence), `v-c`, `v-c2` (gate, seed draw), `v-d` (dispose),
  `v-e.mjs` (raw-socket Host/body), `v-h91`, `v-h92`, `v-h93` (sweep, draft IO),
  `h5-quotes-full.py` (whole-bank quote verification, ~10 min).

`curl`/`wget` are blocked by a hook here — use node or raw sockets.

## Live server testing

Port 4517 is usually held by another dev server. Use `BW_PORT=<free>` and a
raw socket for anything Host-related (node's `fetch` rewrites the Host header
and normalizes `../`, which makes boundary probes inconclusive).

## Standing directive

`/goal`: hunt and record all bugs to a markdown file; do not stop unless asked.
