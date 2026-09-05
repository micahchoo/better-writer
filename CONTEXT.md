# Better Writer

An agent-backed Markdown editor that asks the writer one sharp craft question about the text around their cursor. The question comes from a seed bank of craft lessons, then is reshaped against the writer's actual words. The model never writes the writer's prose; it only asks.

## Language

### The bank

**Seed**:
One actionable craft question derived verbatim from a craft-book claim. The bank's unit of storage. Only the `question` field enters the model prompt. A request can supply up to three candidate questions.
_Avoid_: prompt, exercise, drill

**Question**:
A seed's `question` field — one or two short imperative sentences addressed to the writer. The only seed-derived input the model ever sees.
_Avoid_: prompt, query

**Verb**:
A seed's intervention kind — `rewrite`, `elaborate`, `elucidate`, `cut`, `transition`, `concept-form`, or `rephrase`. An audit field for coverage; never fed to the model.
_Avoid_: action, task, category

**Genre**:
The craft axis a seed applies to — `fiction`, `creative-nonfiction`, `memoir`, `essay`, `poetry`, or `genre-agnostic`. The writer picks it in a dropdown; `genre-agnostic` matches any. Used once to select the seed, then discarded.
_Avoid_: category, type, mode

**Source**:
A seed's provenance — `{ book, author, chapter, quote }`, the quote verbatim from the source book. The anti-hallucination anchor; never fed to the model and never surfaced to the writer.
_Avoid_: citation, attribution, reference

**Drawer**:
The pull procedure shared by every coach mode: split the candidate pool into a preferred pile and the rest, draw from one pile by weighted coin (probability shrinks automatically when the preferred pile is thin), sample uniformly inside whichever pile wins. A uniform draw when nothing is preferred. Preference never eliminates candidates.
_Avoid_: ranker, recommender, top-pick

**Pull**:
Fetch one seed whose genre list matches the chosen genre, through the Drawer. Without further preference, each specific-genre seed has three times the weight of an agnostic-only seed. Runtime candidate draws also spread intervention kinds.
_Avoid_: ranker, top-pick

### The text

**Draft**:
The writer's document — a Markdown file the editor edits and the coach reads. Persisted locally as plain Markdown.
_Avoid_: note, buffer

**Text Window**:
The writer's live text around a focus: the block under the cursor plus one neighbor on each side (auto-ask), or a sweep-plan window cut at section boundaries within a character budget. Never the whole draft. Contains contiguous draft text, focus offsets, and actual section-position metadata. The prompt includes the passage and focus as JSON strings. Stops at section boundaries.
_Avoid_: context, snippet, excerpt

**Block**:
A paragraph, a list item, or a heading. The unit the text window is cut from.

**Section Boundary**:
A heading line (or horizontal rule) that ends a chapter or section. The text window never crosses one.

### The coach

**Reshape**:
Select an applicable candidate and specialize its craft intent against the text window. Produce one question with an exact evidence quote, or abstain.

**Topic Probe**:
A fixed fallback used by the legacy evaluation baseline. The current agent abstains instead. Existing saved annotations can still carry this source label.

**Annotation**:
One pinned note: a persistent ID, anchor span, and question, saved with the draft. Live edits map the span without changing its ID. Lives at data/annotations/current.json on the server; in the browser when no server exists.
_Avoid_: comment, bookmark

**Output Gate**:
The mechanical checks before display: question syntax, exact unique evidence in the focus, evidence use, seed-copy rejection, and echo rejection. Invalid output gets one corrective retry, then no annotation. These checks do not prove semantic relevance.
_Avoid_: validator, filter, sanitizer

**Coach Panel**:
The docked bottom-right UI region for coach output. Shows pinned notes and sweep controls while sweeps run.
_Avoid_: chat log

**Word-Count Trigger**:
Automatic coaching runs after thirty net-new prose words and a twenty-second pause. It runs only in static and local modes.

**Coach**:
The model whose only job is to ask or abstain. It runs locally or through the writer's own provider key. Code checks its output. It has no draft-editing operation.
_Avoid_: assistant, clerk, editor

**Fake Coach**:
The model stand-in for static hosting: no model, no server. The coach shows a randomly pulled seed's `question` verbatim. Powers the GitHub Pages demo; persistence falls back to the browser.
_Avoid_: mock, stub, placeholder

## Session ownership

**Document Session**:
Owns one storage adapter, draft revision, annotations, and save lifecycle.
Model changes do not replace this session.
A late annotation is accepted only when its document and evidence still match.

**Coaching Session**:
Owns one active ask or sweep, its captured coach, and its cancellation signal.
A model change, Stop, Clear notes, or disposal invalidates pending results.

**Evidence**:
An exact quote that occurs once in the focus block and appears unchanged in the question.
Code computes its offsets. A touched quote invalidates its annotation during live edits.

**Abstention**:
A normal result when no candidate fits. Invalid output and model unavailability have separate outcomes.
