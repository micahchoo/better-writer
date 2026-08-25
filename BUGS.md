# Open bugs — better-writer

Date: 2026-08-24. Three rounds have run over this codebase: a two-hunt report
(61 findings, fixed in `f37a156`), a review of those fixes (R1-R6), and a
class-level hunt in three waves (H1-1..H9-3, 30 findings). Everything resolved
and measured has moved to [FIXED.md](FIXED.md).

Three things are open. Two are README claims — writing decisions about what
the product promises, left for the author. The third is an editorial project
on the seed bank, not a code defect, and is described with its true scale
rather than partly done.

`npx tsc --noEmit` clean; `npx vitest run` 531 tests green;
`python3 -m pytest seeds/test_retrieve.py` 39 tests green.

| # | Kind | Area | Open question |
|---|------|------|----------------|
| R5 | doc | README.md | `BW_STT_MODEL_DIR` is documented as required; it is not |
| R6 | doc | README.md | Two of the three promises made for the gate are not gate properties |
| H5-3 | data | seeds/bank.* | 194 of 1759 source quotes are not verbatim |

---

## R5 — The `BW_STT_MODEL_DIR` README line is still false (was S3-12, half done)

The code half is done and done well: `resolveModelDir` now warns, naming both
the ignored env dir and the cache it fell back to (`src/stt/model.ts:43-52`).

The doc half of the same entry was not touched. `README.md:131` still reads:

| `BW_STT_MODEL_DIR` | unset | Parakeet folder; dictation is off without it |

"dictation is off without it" is false, and `resolveModelDir` is the proof —
step 2 of its own docstring is "Cached path if all four model files are
present". On this machine `~/.cache/better-writer/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`
is populated, and dictation works with the variable unset. I verified it: the
live `/transcribe` test in the S1-3 check ran with no `BW_STT_MODEL_DIR` set and
returned 200.

**What would make it solid.** One line: `Parakeet folder; overrides the
~/.cache/better-writer default. Dictation needs one of the two.`

---

## R6 — The README hangs three promises on the gate; it earns one

Not a re-opened entry — a new one that the S1-0 fix brings into range.

The S1-0 fix is real and I verified it (`.bughunt/probe14.ts`: all three attack
shapes now blocked). It earns the strongest of the three README claims. But
`README.md:25-30` hangs three claims on it — two of the four bullets, plus the
sentence that tells the reader why to believe them — and the gate is syntactic
by design, so it can only reach the last:

> - It never writes a sentence for you.
> - It never edits your draft.
> - It never explains itself or gives advice.
> - It never phones home. […]
>
> These are not polite instructions in a prompt. The app can only display one
> question. Anything else the model produces is thrown away.

Measured with `.bughunt/t2.ts` against the hardened gate:

```
true   "Rewrite the whole paragraph in second person?"
true   "Cut the adverbs and let the verbs carry it, yes?"
true   "Consider replacing \"looked careless\" with a flick of the wrist, no?"
```

Each is one sentence, one final `?`, no list, under 280 chars — a clean pass.
Each is advice. The first is arguably a sentence written for the writer.

This is not a defect in `isSingleQuestion`; a syntactic check cannot read
intent, and its own docstring says so plainly. It is a defect in the README,
which sells a syntactic guarantee as a semantic one. "The app can only display
one question" is now true. "It never gives advice" is a property of the seed
bank and the prompt, not of the gate — which is exactly the distinction the
paragraph tells the reader not to make.

**What would make it solid.** Keep "the app can only display one question,"
which the gate now earns. Move the two bullets out from under "these are not
polite instructions in a prompt" and say what actually holds them up: every
question starts as a seed from the bank, and the model is only ever asked to
rewrite one.

---

# Wave three — class-level hunt, 2026-08-24

Twenty verified defects at the post-R1–R4 working tree (tsc clean, 29 files /
484 tests green). Evidence for each is an executed probe under `.bughunt/`;
all probes re-run clean there. The recurring pattern is the one that produced
R2/R3: a heuristic keyed on exact tables, bare suffix tests, and ASCII
character classes instead of the English class it names.

| # | Sev | Area | Defect |
|---|-----|------|--------|
| ~~H1-1~~ | S2 | web/window-stats.ts | filter-word axis matches six past-tense forms only — fixed, see FIXED.md |
| ~~H1-2~~ | S2 | web/window-stats.ts | sentence splitter splits on abbreviations and ellipses — fixed, see FIXED.md |
| ~~H1-3~~ | S2 | web/window-stats.ts | nominalization suffix test is part-of-speech-blind; "moment" fires it — fixed, see FIXED.md |
| ~~H1-4~~ | S2 | web/window-stats.ts | ~~names ending in -ly fire the hedge axis~~ — fixed, see FIXED.md |
| ~~H1-5~~ | S2 | web/cadence.ts | raw markdown syntax counts toward the 30-word auto-ask threshold — fixed, see FIXED.md |
| ~~H1-6~~ | S3 | web/window-stats.ts | ~~frequency -ly adverbs contradict the table's docstring~~ — fixed, see FIXED.md |
| ~~H1-7~~ | S3 | web/window-stats.ts | dialogue spanning a newline is invisible to the dialogue axis — fixed, see FIXED.md |
| ~~H2-1~~ | S2 | src/gate.ts | isSingleQuestion rejects genuine questions containing abbreviations, decimals, "?!" — fixed, see FIXED.md |
| ~~H2-2~~ | S2 | src/gate.ts | ASCII-only tokenizer mangles accented words; echo/copy checks silently miss — fixed, see FIXED.md |
| ~~H2-3~~ | S2 | web/coach.ts + seeds/retrieve.py | genre preference is pile-level: inverts on big piles, concentrates tiny ones — fixed, see FIXED.md |
| ~~H2-4~~ | S3 | src/topic-probe.ts | fallback probe [5] is an imperative, not a question — fixed, see FIXED.md |
| ~~H3-1~~ | S3 | web/anchor.ts | ~~U+0130 case-folding shifts match offsets~~ — fixed, see FIXED.md |
| ~~H3-2~~ | S3 | web/save-coordinator.ts | dispose() cannot stop the in-flight save's finally-block re-arm; a save fires after unmount — fixed, see FIXED.md |
| ~~H4-1~~ | S3 | src/server.ts, boundary.ts | malformed Host crashes to a generic 500 before the boundary runs; hostWithoutPort accepts "[::1]<suffix>" — fixed, see FIXED.md |
| ~~H4-2~~ | S3 | src/server.ts | no body-size cap: a 50 MB /save is accepted, buffered, written to disk — fixed, see FIXED.md |
| ~~H4-3~~ | S3 | src/server.ts | /ask returns internal error text verbatim while /transcribe sanitizes — fixed, see FIXED.md |
| ~~H5-1~~ | S2 | seeds/retrieve.py | _validate enforces far less than schema.json declares; unknown verb/genre and empty question stored — fixed, see FIXED.md |
| ~~H5-2~~ | S2 | seeds/*.json + retrieve.py | duplicate ids across extraction files silently clobbered a distinct seed via upsert — fixed, see FIXED.md |
| H5-3 | S3 | seeds/bank.* source.quote | composite stitched quotes and confirmed paraphrases break the verbatim-quote contract |
| ~~H5-4~~ | S3 | seeds/vocab.json | non-seed constants file sits inside the seed-artifact directory — fixed, see FIXED.md |

## H5-3 — Quote-provenance drift: 194 of 1759 quotes are not verbatim

`seeds/schema.json` says `source.quote` is "Copied exactly - no paraphrase, no
repair", and calls it the anti-hallucination anchor. It is the one field that
proves a seed came from a real craft book rather than from a model.

**Scale, measured over the WHOLE bank** (`.bughunt/h5-quotes-full.py`, a
ligature/smart-quote/hyphenation-tolerant substring match against `Books/`):

```
Showing & Telling    322/347 verified  (25 miss)
Steering the Craft   202/233 verified  (31 miss)
Stein On Writing     736/792 verified  (56 miss)
Storycraft           305/387 verified  (82 miss)
TOTAL              1565/1759 verified  (194 miss, 11%)
```

A 120-seed hand-audit of those misses split roughly 40/60 between matcher
artifacts (OCR ligatures like `ﬂ at`, hyphen-wrapped words — the quote IS
verbatim) and real drift, which is of three kinds:

- **stitched composites** — one `quote` built from non-contiguous sentences
  (`stein-originality-06` joins six separate sentences;
  `stein-suspense-chapter-length` concatenates a bulleted list),
- **dropped mid-attribution** (`storycraft-ch06a-scene-volume-space`),
- **paraphrase/truncation** — three Le Guin seeds differ from BOTH editions
  ("not slack" for the book's "not slacking"; "cut them." for "cut them
  softly"; a chapter list reordered with "changing" added).

**Why this is not fixed here.** Repairing it is editorial work on source data,
not a code change: each of ~110 real cases needs a decision against the book —
repair the quote to an exact span, or admit the seed derives from several
spans. Fixing only the dozen a sample happened to print would leave the
contract equally broken while making it look mended, which is the exact
failure pattern this whole review has been correcting (see R1-R4).

**What it needs, in order:**

1. A schema that can express the truth. A seed legitimately derived from
   non-contiguous sentences has SEVERAL verbatim quotes, and `quote: string`
   cannot say so. Allow `source.quotes: string[]`, each verbatim, keeping
   `quote` for the single-span case.
2. A normalizing verifier promoted out of `.bughunt/` into the seed tooling,
   so ligature and hyphenation artifacts stop counting as drift and the real
   number is trustworthy.
3. A pass over what survives (1), repairing or splitting each quote against
   the book; drop any seed whose claimed source cannot be found at all.
4. `_validate` gains the verbatim check, so the number can never grow again —
   the same move that closed H5-1.

## Suspects — plausible, not yet proven

- **MAX_QUESTION_LENGTH=280 recall cost** (src/gate.ts): a prompt asking the
  model to quote the writer's exact words can legitimately exceed 280 chars;
  cap passes at exactly 280, rejects at 282. Cost unmeasured; k-sweep exists.
- **Unstemmed bigram echoes** (wordBigrams): 'smell of bread' vs 'smelled of
  bread' mismatches independent of H2-2; no clean single-input flip isolated.
- **parsePullOutput validates only `question`**: a mis-tagged bank row whose
  genre mismatched the request would still be served; needs a malformed bank
  fixture to prove.
- **persistNow has no retry** while trySave gets one silent retry; pending
  survives, but if no later edit lands, onError is the only trace.
- **Combining-mark token split** (é as e+U+0301 splits "création"): matching
  gap only, offsets stay self-consistent; no contract promises mark-awareness.
- **Crash-mid-write torn draft**: saveDraft uses direct writeFile (no
  tmp+rename); ioSerial prevents interleaving, not crash atomicity. Source-
  level risk; SIGKILL timing could not be reproduced deterministically.
- **Stray double-quote pairs unrelated prose** into a dialogue span
  (dialogueDensity inflation) — every repro case was malformed input.

---

# Wave four — EditorApp, BYOK, dictation, STT streaming, 2026-08-24

A second round covered the files the first pass skipped: EditorApp
orchestration, web/byok.ts + web/dictation.ts, src/stt/** and the deep CM6
seam. Seven more verified defects — two S2 (both are double-fire shapes: a
missing in-flight guard and a guard reading the wrong variable), five S3.
All evidence re-executed against this tree; probes under `.bughunt/`
(h6-/h7-/h8- prefixes). dictation.ts itself and most of the STT decode path
came back clean.

| # | Sev | Area | Defect |
|---|-----|------|--------|
| ~~H6-1~~ | S2 | web/EditorApp.tsx | auto-ask double-fires while an ask is in flight — fixed, see FIXED.md |
| ~~H6-2~~ | S3 | web/EditorApp.tsx | sweep button re-entrant on double-click — fixed, see FIXED.md |
| ~~H6-3~~ | S3 | web/EditorApp.tsx | load with zero annotations keeps stale notes on screen (latent) — fixed, see FIXED.md |
| ~~H7-1~~ | S3 | web/byok.ts | whitespace-padded config passes sanitize, builds broken requests — fixed, see FIXED.md |
| ~~H7-2~~ | S2 | web/byok.ts | TRANSCRIBES_AUDIO never enforced; stale sttModel sends keyed POST to a dead route — fixed, see FIXED.md |
| ~~H7-3~~ | S3 | web/byok.ts | raw provider bodies surface in error messages; 200-non-JSON throws raw SyntaxError — fixed, see FIXED.md |
| ~~H8-1~~ | S3 | src/stt/client.ts | openStream() has no hung-worker deadline; transcribe() does — fixed, see FIXED.md |

## Suspects (round two)

- **MediaRecorder constructed inside try, stream not stopped if construction
  throws** (EditorApp toggleDictation): mic stays live; static read only.
  Related: no recorder.onerror handler, so a mid-record device error leaves
  dictationState 'recording' forever. Needs a browser harness to prove.
- **Mode-switch mid-ask persistNow clobber**: getStore() is read at save
  time; an ask resolving just after a switch persists the OLD draft into the
  NEW store (with H6-3's stale notes). Timing window is narrow; not
  deterministically reproduced.
- **Sweep note offsets vs live typing**: note.start indexes plan-time
  fullText but persists against draftRef.current; transient until the next
  reconcile re-anchors.
- **pushHighlights first-effect-wins inside ONE transaction**
  (web/decorations.ts highlightField): contradicts its own docstring, and
  older spans win if two pushes ever share a transaction. Through today's
  seam (one dispatch per showHighlights) behavior is correct — latent.
- **replaceDocument history:'exclude' pins caret to offset 0**: undocumented
  side effect; confirm intent before calling it a bug.

---

# Wave five — coach-sweep reconcile, 2026-08-24

The last unhunted core module: annotation re-anchoring and sweep planning.
Three verified defects, all S3; the reconcile identity-diff semantics
(reconcileAnnotations twice → changed=false stable, pure remap → changed=true,
EditorApp's `changed` branch adopts correctly) came back clean, as did sweep
window coverage (no double-visit or skip) and per-sweep note dedupe.

| # | Sev | Area | Defect |
|---|-----|------|--------|
| ~~H9-1~~ | S3 | web/coach-sweep.ts | nearest-occurrence remap flips to a WRONG duplicate after any forward shift — fixed, see FIXED.md |
| ~~H9-2~~ | S3 | web/coach-sweep.ts planSweep | thematic breaks become the cursor block; degenerate "---"-only windows waste asks — fixed, see FIXED.md |
| ~~H9-3~~ | S3 | src/draft.ts | direct loadDraft/saveDraft seam has no synchronization; torn/stale reads reproduced — fixed, see FIXED.md |
