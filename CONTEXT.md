# Better Writer

An agent-backed Markdown editor that asks the writer one sharp craft question about the text around their cursor. The question comes from a seed bank of craft lessons, then is reshaped against the writer's actual words. The model never writes the writer's prose; it only asks.

## Language

### The bank

**Seed**:
One actionable craft question derived verbatim from a craft-book claim. The bank's unit of storage. The runtime payload is the seed's `question` field only.
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

**Pull**:
Fetch one seed whose genre list matches the chosen genre. A uniform random sample — never the top pick — so no single question becomes a favorite.

### The text

**Draft**:
The writer's document — a Markdown file the editor edits and the coach reads. Persisted locally as plain Markdown.
_Avoid_: note, buffer

**Text Window**:
The writer's live text around the cursor: the current paragraph plus the block before it and one or two after. Passed to the model as raw text, the cursor paragraph wrapped in `[CURSOR START]` / `[CURSOR END]`. Stops at section boundaries; never reaches past one.
_Avoid_: context, snippet, excerpt

**Block**:
A paragraph, a list item, or a heading. The unit the text window is cut from.

**Section Boundary**:
A heading line (or horizontal rule) that ends a chapter or section. The text window never crosses one.

### The coach

**Reshape**:
Specialize a pulled seed's question against the text window. Keep the seed's intent; replace its generic nouns with the words actually in the text. Produce one question, addressed to the writer, in their own words.

**Topic Probe**:
A fixed, agent-side list of content-level questions for when a seed cannot be reshaped against the window. Lives in the agent, not the bank.

**Output Gate**:
The mechanical check the reshaped output must pass before it reaches the writer: one sentence, ending in `?`, no list, no trailing text. A failed output gets one corrective retry, then falls back to a topic probe. The gate rejects; it never rewrites.
_Avoid_: validator, filter, sanitizer

**Coach Panel**:
The docked bottom-right UI region that shows the single reshaped question. One slot; a new question replaces the old.

**Word-Count Trigger**:
The rule that pulls a new question: thirty net-new words written since the last question, then a short idle pause. A manual "ask now" always stays available.

**Coach**:
The small local model whose only job is to ask. Runs locally — no hosted API. It composes freely and commits nothing; the code verifies, the model only asks.
_Avoid_: assistant, clerk, editor

**Fake Coach**:
The model stand-in for static hosting: no model, no server. The coach shows a randomly pulled seed's `question` verbatim. Powers the GitHub Pages demo; persistence falls back to the browser.
_Avoid_: mock, stub, placeholder
