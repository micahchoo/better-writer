# Bug hunt — better-writer

Date: 2026-08-24. Scope: all production code — `src/` including `src/stt/`,
`web/`, `seeds/retrieve.py`, plus a skim of `scripts/experiment/`. Tests were
read only as spec, not audited.

Two findings are proven by runtime checks under node v24.14.0 / Bun. The rest are
code-path findings: each names the exact lines and the failure sequence. Severity
measures writer-visible harm, not code size.

| # | Severity | Area | Finding |
|---|----------|------|---------|
| 1 | High | src/boundary.ts | Origin check drops ports; another local service can CSRF `/save` |
| 2 | Medium | web/save-coordinator.ts | Null store resolves as a successful save; data silently lost |
| 3 | Medium | web/draft-store.ts | localStorage quota error still shows "Saved HH:MM" |
| 4 | Medium | web/editor-access.ts | Stale deferred highlights can clobber a newer push |
| 5 | Med-low | src/server.ts | GET or HEAD with a body returns 500 |
| 6 | Med-low | web/EditorApp.tsx | BYOK settings round-trip silently deletes `sttModel` |
| 7 | Low-med | src/server.ts | Annotation parser accepts NaN offsets |
| 8 | Low | web/window-stats.ts | Cursor-marker tokens pollute every window measurement |
| 9 | Low | src/reshape.ts | Transport failure mislabeled `syntax`; double 180 s hang |
| 10 | Low | web/EditorApp.tsx | Auto-ask anchors against pre-await text, persists post-await |
| 11 | Low | web/EditorApp.tsx | Double draft load on every BYOK adopt/disconnect |
| 12 | Info | web/draft-store.ts | `saveAnnotations` persists notes over a cached stale draft |
| 13 | Info | src/draft.ts | Non-array annotation JSON passes through unvalidated |
| 14 | Info | web/anchor.ts | Anchor fragments can end mid-word |
| 15 | Med-low | src/stt/client.ts | `end()` on an errored stream hangs forever |
| 16 | Low | src/stt/client.ts | Stream-end result reports empty token timings |
| 17 | Info | src/stt/client.ts | Worker path via `URL.pathname`; post-dispose use races a SIGKILL |

---

## ~~1. Boundary guard accepts a cross-port loopback Origin (High)~~
**Fixed 2026-08-24** — `boundaryViolation` compares the full authority including listen port; uppercase-Host accepted too (S3-5 layer). Evidence: `npx vitest run src/boundary.test.ts src/server.test.ts` 33 passed.

**Where:** `src/boundary.ts:24-34` (`hostWithoutPort`) and `src/boundary.ts:72-73`.

`hostWithoutPort` strips the port from both the `Host` header and the `Origin`
authority before the comparison at line 73. The doc comment promises "the exact
authority in `Host`"; an authority includes the port. The implementation compares
hostnames only.

**Proof** (runtime, Bun):

```text
boundaryViolation('127.0.0.1', '127.0.0.1:4517', 'http://127.0.0.1:9999') === null
boundaryViolation('127.0.0.1', '127.0.0.1:4517', 'https://evil.example') === 'cross-origin …'
```

**Impact:** any process on this machine that can make a browser POST to its own
port can write to this app's endpoints. Concretely: some other local app serving
`http://127.0.0.1:9999` sends `POST /save` with `Origin: http://127.0.0.1:9999`
and `Host: 127.0.0.1:4517`. The guard sees matching hostnames and allows the
write. `/save` overwrites the writer's real draft.

**Fix:** compare full authorities. Keep an allowlist of loopback hostnames, but
require the Origin port to equal the configured listen port:

```ts
const originUrl = new URL(origin);
const sameAuthority = originUrl.host === `${hostName}:${listenPort}`
  || originUrl.hostname === hostName && originUrl.port === String(listenPort);
```

Pass the listen port into `boundaryViolation` from `src/server.ts:72`.

## ~~2. A null store saves nothing but reports success (Medium)~~
**Fixed 2026-08-24** — null store routes through the retry→onError path, payload retained, never pulses 'saved'. Evidence: web/save-coordinator 16 passed.

**Where:** `web/save-coordinator.ts:81-87`.

```ts
await this.store?.save(payload.draft, payload.notes);
if (this.pending === payload) {
  this.pending = null;
  this.options.onSaveState?.('saved');
}
```

`this.store?.save(...)` evaluates to `undefined` when `getStore()` returns null.
The await then resolves normally, the pending payload clears, and the indicator
pulses "saved". The bytes went nowhere.

**Reachability:** `EditorApp` mounts `CodeMirrorHost` unconditionally
(`web/EditorApp.tsx:853`) while `mode === 'detecting'`, but
`draftStoreRef.current` stays null until the `/health` probe settles
(`web/EditorApp.tsx:192-212`). The probe waits up to 1000 ms
(`detectServerMode(timeoutMs = 1000)`). A writer who types within that first
second produces a debounced save straight into the null store.

**Fix:** treat a null store as a failure: keep the pending payload and route an
error through `onError`, or short-circuit `trySave`/`flush` before claiming
`inFlight`:

```ts
if (!this.store) throw new Error('no draft store attached yet');
```

## ~~3. Quota-exceeded local save still displays "Saved HH:MM" (Medium)~~
**Fixed 2026-08-24** — LocalStorageDraftStore.save rejects QuotaExceededError; one silent retry, then persistent error toast. Evidence: web/draft-store 17 passed.

**Where:** `web/draft-store.ts:62-67` and the coordinator's success pulse
(`web/save-coordinator.ts:80-87`).

`LocalStorageDraftStore.save` catches every `setItem` throw — including
`QuotaExceededError` — and resolves. The comment says "fail soft: the writer
keeps typing". But the caller cannot distinguish "wrote" from "dropped": the
coordinator marks the round trip saved and stamps the completion clock
(`EditorApp.tsx:147-155`). The top bar reads "Saved 21:47" while the browser
holds the only copy of the draft.

This contradicts the module's own contract header: the store "persists them too"
is true of the wire, not of a failed setItem. Fail-soft belongs in UX wording,
not in a false confirmation signal.

**Fix (small):** rethrow inside `save` after logging, so the coordinator counts
it as the first failure and arms its single retry; surface a distinct message
once storage dies twice. Keep `load` fail-soft; only the write path lies today.

## ~~4. Composition-deferred highlights can overwrite a newer push (Medium)~~
**Fixed 2026-08-24** — showHighlights' direct-dispatch branch clears `pendingSpans`; regression 'a direct highlight push supersedes composition-deferred spans'. Evidence: editor-access 27 passed.

**Where:** `web/editor-access.ts:124`, `142-150` (`flushPendingHighlights`),
`263-278` (`showHighlights`).

Failure sequence:

1. An IME composition starts. React pushes highlights `A`;
   `view.composing` is true, so `pendingSpans = A`.
2. The composition ends without producing a transaction (an emptied composition;
   CM tracks composing via DOM events, not transactions), so no update listener
   tick runs and `pendingSpans` stays parked.
3. The writer types a normal character. `handleContentChange` reconciles,
   `setSweepNotes` fires, and the effect at `EditorApp.tsx:297-300` calls
   `showHighlights(B)`. Not composing now, so `B` dispatches directly. Correct
   state: `B`.
4. Any later transaction — even a selection-only arrow-key move — runs the
   update listener, which sees `pendingSpans = A` and dispatches it wholesale.
   The decorations revert to stale span `A` until the next authoritative push.

Step 2 is the only probabilistic part; steps 3–4 are deterministic once
`pendingSpans` survives past its composition.

**Fix:** give each parked batch a token and let `showHighlights` clear
`pendingSpans` whenever it dispatches directly (`pendingSpans = null` in the
non-composing branch). One line closes the ordering hole.

## ~~5. GET/HEAD requests carrying a body return 500 (Med-low)~~
**Fixed 2026-08-24** — exported `adapterBody(method, body)` attaches bytes only for body-bearing methods. Evidence: src/server.test.ts green; raw node probe no longer throws inside the adapter.

**Where:** `src/server.ts:317-328` (`handle`).

The adapter builds `new Request(url, { method: req.method ?? 'GET', body })`
with a body whenever the client sent bytes. Node's undici rejects that
combination outright. Runtime proof, node v24.14.0:

```text
$ node -e "new Request('http://x/', {method:'GET', body:Buffer.from('hi')})"
TypeError: Request with GET/HEAD method cannot have body.
```

The throw escapes `app.fetch` into the catch-all at `src/server.ts:309-315`,
which answers 500. Any proxy, health checker, or scanner that attaches a body to
GET turns a harmless request into an error log entry and a 500.

**Fix:** pass a body only for methods that accept one:

```ts
body: req.method === 'GET' || req.method === 'HEAD' || body.length === 0 ? undefined : body,
```

## ~~6. Saving BYOK settings deletes a stored `sttModel` override (Med-low)~~
**Fixed 2026-08-24** — form seeds `sttModelFor(cfg)` and persists the field (blank degrades to provider default); Dictation-model field added to the panel. Evidence: web/EditorApp.test.tsx 10 passed.

**Where:** `web/EditorApp.tsx:607-636` (`saveByokSettings`) against
`web/byok.ts:73-75` (`sttModelFor`) and `110-125` (`sanitize`).

`sanitize` preserves an optional `sttModel`; `sttModelFor` honors it as the
highest-priority dictation model. But:

- the settings form carries only provider/baseUrl/model/apiKey
  (`EditorApp.tsx:111-116`);
- `openByokPanel` seeds the form from the config without reading `sttModel`
  (`EditorApp.tsx:578-588`);
- `saveByokSettings` writes a config object that never includes `sttModel`
  (`EditorApp.tsx:625-630`).

So the only way to set `sttModel` is editing localStorage by hand, and opening
BYOK settings and clicking Save erases it. Today OpenAI/Groq defaults mask the
loss, which is why nobody noticed; the "explicit override wins" path is dead
code reached only by manual storage surgery.

**Fix:** carry `sttModelFor(cfg)` into the form seed and add the field to the
panel, or drop `sttModel` from the schema entirely. Half-supported config keys
are worse than absent ones.

## ~~7. `/save` accepts NaN annotation offsets (Low-med)~~
**Fixed 2026-08-24** — parseAnnotation demands finite integers, start>=0, end>start; invalid entries skipped, non-array body → 400. Evidence: src/server.test.ts covers NaN/-5/inverted rejection.

**Where:** `src/server.ts:119-133` (`parseAnnotation`).

Validation is `typeof a.start === 'number'`. `typeof NaN === 'number'`;
likewise `Infinity`, `-Infinity`, `-5`, and `end < start`. All pass, get JSON-
serialized into `data/annotations/current.json`, and ride back on `/load`.

Client defense exists but is lossy: `loadDraftAndNotes` filters through
`staleAnnotations` (`EditorApp.tsx:238`), where a `NaN` start fails the slice
comparison and the note disappears. Net effect: a malformed `/save` silently
truncates a writer's saved notes instead of being rejected at the door.

**Fix:** require `Number.isFinite(start) && Number.isFinite(end) &&
Number.isInteger(start) && start >= 0 && end > start`. Same shape check costs
nothing at request time.

## ~~8. Cursor markers distort every measured window (Low)~~
**Fixed 2026-08-24** — stripMarkdown removes `[CURSOR START]`/`[CURSOR END]` first; marker-laden stats deep-equal cleaned prose. Evidence: window-stats 41 passed.

**Where:** `web/window-stats.ts:145-162` (`stripMarkdown`) and the call site
`src/server.ts:98`.

`/ask` measures `textWindow` verbatim, and that string embeds the literal
tokens `[CURSOR START]` and `[CURSOR END]`. `stripMarkdown` strips fences,
links, headings, list markers, emphasis — but not these two tokens, whose four
words join the token stream and the sentence splitter's input.

Runtime check (Bun) on identical prose with and without the markers:

```text
sentenceMean with markers : 15.75
sentenceMean cleaned      : 14.75
```

Every rate axis divides by a totalWords count inflated by 4, and the rhythm
axis eats the marker words into its sentence statistics. Small per call,
systematic across every ask ever made.

**Fix:** strip the markers first, exactly like `gate.ts` does:

```ts
s = s.split(CURSOR_START).join(' ').split(CURSOR_END).join(' ');
```

## ~~9. Coach transport failures retry and misreport as `syntax` (Low)~~
**Fixed 2026-08-24** — GateFailure gains `'transport'`; transport short-circuits without the second attempt and logs its own class. Evidence: reshape 12 passed, attempts=1 on dead endpoint, syntax still retries.

**Where:** `src/reshape.ts:126-130`.

```ts
} catch {
  return { ok: false, reason: 'syntax' };
}
```

Two consequences:

- When the coach endpoint is down, the first attempt burns the full 180 s
  timeout (`DEFAULT_TIMEOUT_MS`, `src/llm.ts:7`), gets labeled `syntax`, then
  `reshape` fires a second identical attempt for another 180 s. `/ask` hangs up
  to six minutes before the topic-probe fallback answers.
- `/ask` logs `{failures:['syntax'], fallback:true}` (`server.ts:100-108`) for a
  dead endpoint, which poisons the gate-failure telemetry the seed-bank work
  relies on to decide probe-fallback rates.

**Fix:** distinguish the catch path — return a dedicated `GateFailure` variant
such as `'transport'`, skip the retry for it (a nudge suffix cannot fix a
socket), and log the real class.

## ~~10. Auto-ask anchors against pre-await text but persists both (Low)~~
**Fixed 2026-08-24** — `reanchorNote`: fire-time snapshot; changed drafts re-anchor with fresh caret or drop the note; persist uses the same snapshot. Evidence: web/EditorApp.test.tsx 10 passed.

**Where:** `web/EditorApp.tsx:350-392` (`askCursorWindow`).

Line 376 anchors with `extractAnchor(question, text, caretOffset)` using the
`text` captured before `await coach.ask(...)`. Lines 383-385 then append the
note and persist `draftRef.current`, which typing may have advanced during the
multi-second ask. Offsets computed on old coordinates ride along until the next
edit reconciles them; edits that keep length constant (transposition, paste of
equal length) leave a highlight pinned to the wrong span indefinitely, because
`staleAnnotations` verifies fragment-at-offset, not meaning.

Severity is capped by reconciliation: most edits remap or drop the note. But
the persistence contract "the anchor span plus the question it was grounded
on" is violated at mint time, not by drift.

**Fix:** anchor and persist against the same snapshot: capture
`const base = draftRef.current` at fire time, and if `draftRef.current !== base`
on resolution, either re-run `extractAnchor` against the current draft with the
fresh caret or drop the note the way sweep does.

## ~~11. Every BYOK adopt/disconnect loads the draft twice (Low)~~
**Fixed 2026-08-24** — handlers rely on the `[mode]` effect alone; one load per transition. Evidence: EditorApp regressions assert single load.

**Where:** `web/EditorApp.tsx:249-252`, `607-636`, `641-648`.

`loadDraftAndNotes(store)` runs when mode becomes known via the `[mode]`
effect, and again explicitly inside `saveByokSettings` and `disconnectByok`.
Changing static→byok or byok→static satisfies both paths in one click: direct
call, then effect-triggered repeat. Each is a full `/load` + annotations read
(static: two localStorage scans).

The seq token (`loadSeqRef`) makes the duplicate safe — the second result wins —
so this is wasted IO and a flicker risk (draft state resets mid-typing if the
writer beats the second load), not corruption. Still worth one line: have the
adopt/disconnect handlers rely on the effect alone.

## ~~12. Latent: `ServerDraftStore.saveAnnotations` writes notes over a cached draft (Info)~~
**Fixed 2026-08-24 (deleted)** — zero production callers; removed from the DraftStore interface entirely; adapter semantics unified so omitted notes KEEP existing annotations (S2-8).

**Where:** `web/draft-store.ts:146-148`.

```ts
async saveAnnotations(notes: Note[]): Promise<void> {
  await this.save(this.draft, notes);
}
```

It POSTs the *cached* draft text. If anything mutated the real draft outside
this instance since the last `load`/`save`, this call overwrites the newer
server-side prose with stale bytes while happily persisting fresh notes. No
production caller exists today — `SaveCoordinator.save` always carries the
current notes, which is why the memory-note "EditorApp always follows a note
change with a draft save" holds. The footgun stays loaded: any future caller
that treats `saveAnnotations` as note-scoped will learn otherwise the hard way.

## ~~13. `/load` serves non-array annotation JSON unchecked (Info)~~
**Fixed 2026-08-24** — `loadAnnotations` guards non-array JSON and drops entries with non-finite/inverted integer offsets. Evidence: full suite green incl. src/draft.test.ts.

**Where:** `src/draft.ts:89-97` (`loadAnnotations`).

The corrupt-file handler catches parse throws, but `JSON.parse` succeeds for
any valid JSON. A file containing `{}` or `"notes"` parses and returns cast to
`Annotation[]`; `/load` then serves `annotations: {}` and the client's
`staleAnnotations` iterates `.flatMap` over a non-array and throws during boot
(`EditorApp.tsx:238`). Truncated files hit the intended path; hand-edited or
externally written files do not.

**Fix:** one guard, mirroring the browser side
(`web/draft-store.ts:74-75`): `Array.isArray(parsed) ? parsed : []`.

## ~~14. Anchor spans can end mid-word (Info)~~
**Fixed 2026-08-24** — end extends to the containing token's boundary; occurrence pairing matches the start half. Evidence: anchor 19 passed ('walkings', 'catcat' whole-token).

**Where:** `web/anchor.ts:200-201` (`findCandidates` offset math).

For substring candidates, the end offset is
`endToken.start + endToken.word.indexOf(sub[k]) + sub[k].length`. Two quirks
fall out:

- If the last matched question-word sits at the front of a longer draft token
  (`walk` inside `walkings`), the fragment ends inside the rendered word, and
  the highlight covers a partial glyph run.
- `indexOf` returns the token's *first* occurrence; a doubled token (`catcat`)
  pairs with the wrong half of itself.

Cosmetic only — popover geometry and inbox previews show a clipped word — but
the fix is cheap: extend `end` to the containing token's own boundary
(`token.start + token.word.length`) when the match does not consume it fully.

## ~~15. `end()` on an errored stream hangs forever (Med-low)~~
**Fixed 2026-08-24** — end() on a missing/errored stream settles immediately with the recorded error. Evidence: new src/stt/client.test.ts 10 passed.

**Where:** `src/stt/client.ts:304-309` (`SttStream.end`) against
`src/stt/client.ts:175-186` (stream-error dispatch).

Failure sequence:

1. `openStream()` succeeds; the writer dictates.
2. A chunk decode fails in the worker. The worker deletes the stream and sends
   `stream-error`; the parent finds the state, fires `errorCbs`, clears
   `pendingEnd`, and deletes the stream from its map (`client.ts:175-186`).
3. The caller — one that did not subscribe to `onError`, or that calls `end()`
   while the error is still propagating — now calls `end()`. The guard
   `if (state.pendingEnd)` passes (the field was just nulled), a fresh deferred
   is stored on a state object no longer in the map, and `stream-end` goes out.
4. The worker answers `stream-error: unknown stream`. The parent's handler
   looks the id up, misses, and continues. Nothing ever settles the deferred.

`end()`'s contract reads "resolves with the final transcript". Instead it
returns an eternally pending promise. Worker alive, so the exit-path rejection
sweep never runs either.

**Fix:** reject `pendingEnd` immediately when the state is gone:
`if (!streams.has(id)) { … }` — or keep errored states around with a
`failed(err)` field so a later `end()` rejects with the recorded error instead
of writing to a dead id.

Note on reachability: production `/transcribe` uses the one-shot path only;
this bites the streaming surface (`openStream`) documented as the wave-4
redesign client.

## ~~16. Stream-end results report empty token timings (Low)~~
**Fixed 2026-08-24** — contract narrowed to `{ text }` (SttStreamFinal); fabricated timing arrays gone.

**Where:** `src/stt/client.ts:162-168`.

```ts
st.pendingEnd.resolve({
  text: msg.text,
  tokens: [],
  timestamps: [],
  durations: [],
});
```

The final partial carries only text over the wire (`PartialResp`,
`src/stt/protocol.ts:69-76`), so `end()` fabricates empty timing arrays behind
a return type that promises per-token data. Any future consumer of
`stream.end().timestamps` gets silently useless output rather than an error or
an honest absence. The server's `/transcribe` ignores these fields today,
which keeps this at Low.

**Fix:** either narrow `end()`'s return type to `{ text: string }`, or add the
timing arrays to the worker's final partial message so the type tells the
truth.

Two smaller nits share a root cause (spawn/dispose lifecycle,
`client.ts:106-113`, `121-122`, `321-334`):

- **Worker path via `URL.pathname`:** line 108-109 builds the child script path
  with `new URL('./worker.ts', import.meta.url).pathname`. Any space or non-
  ASCII character in the repo path percent-encodes into the spawn argument, and
  the worker never loads. Use `fileURLToPath`.
- **Post-dispose race:** `dispose()` writes shutdown then schedules SIGKILL
  after 1 s. A `transcribe()` call inside that window sees `child.killed`
  still false, reuses the dying process, and its request dies by SIGKILL mid-
  decode (rejected as "killed by signal"). Unreachable through the current
  server (it never calls `dispose()`), but the seam invites it.

---

## Verified-working spot checks

Recorded so the report shows what passed, not only what failed:

- `gate.isSingleQuestion` correctly accepts a plain trailing-`?` question.
- `boundaryViolation` still rejects remote origins and localhost-alias mismatch
  (only the port dimension is broken, see #1).
- `pickSeed` mirrors `retrieve.py pull`'s FLOOR shrink and complement logic
  faithfully (`web/coach.ts:138-173` vs `seeds/retrieve.py:185-220`).
- `runSweep`'s ordered-drain slot design holds under out-of-order asks; the
  `lastSource` read after `await ask()` cannot interleave because the
  assignment and the read sit in atomic microtasks.

---
---

# Second hunt — 2026-08-24 (independent pass)

A separate sweep of the same tree, run from a green baseline: `npx tsc
--noEmit` clean, `npx vitest run` 25 files / 377 tests passing. Every finding
below therefore sits **underneath** a passing suite — none is a failing test.

Method differs from the pass above: findings are driven by executable probes
(kept in `.bughunt/`), a live server on `BW_PORT=4599` with the Parakeet model
present, and raw-socket requests where `fetch` normalises away the thing under
test.

Severity key:
- **S1** — loses or corrupts the writer's work, or spends their money.
- **S2** — wrong behaviour a writer meets in normal use.
- **S3** — wrong in a narrow case, or a doc/code contradiction that will
  mislead the next change.
- **S4** — smell, cost, dead code, or accessibility.

### Overlap with the first hunt

| First hunt | This hunt | Note |
|---|---|---|
| #2 null store saves nothing | **S1-1** | Same bug, independently found. This entry adds the measured `onSaveState` trace. |
| #3 quota error shows "Saved" | **S3-1** | Adjacent: #3 is the store lying, S3-1 is the indicator having no failure input at all. |
| #11 double draft load | **S3-6** | Same bug. |
| #13 non-array annotations | **S3-15** | Same class; S3-15 adds that the *browser* store validates nothing either. |
| #14 anchor spans end mid-word | **S2-7** | S2-7 measures the blast radius: 98.7 % of static-mode anchors are one word. |
| #15 `end()` on an errored stream hangs | **S3-11** | Two distinct holes in the same dead surface (S4-8): #15 is the parent losing the stream state, S3-11 is the worker never sending `stream-error` for a bad payload. |

Findings unique to the first hunt that this pass missed: **#1** (Origin port
stripping — I tested the Host *case* dimension, S3-5, and not the port),
**#8** (cursor markers inflating every window measurement), **#5** (GET with a
body → 500), **#6** (`sttModel` erased on settings save), **#4**
(composition-deferred highlights clobbering a newer push), **#9** (transport
failure mislabeled `syntax`, double 180 s hang), **#10** (auto-ask anchoring
against pre-await text), **#16** (empty token timings on stream-end).

The first-hunt list was still growing while this section was written; the table
above reflects entries #1-#16.

---

## ~~S1-0 — The Output Gate lets the model write the writer's prose~~
**Fixed 2026-08-24** — isSingleQuestion enforces one-sentence (quote-aware, quoted-? exempt), length cap 280, fullwidth/list/decor gaps closed; the S1-0 probes now fail the gate and fall back to topic-probe. Evidence: gate 47 passed, integration through reshape verified.

`src/gate.ts:24-33` (`isSingleQuestion`)

This is the mechanism the README presents as the app's structural guarantee:

> These are not polite instructions in a prompt. **The app can only display
> one question. Anything else the model produces is thrown away.**
>
> - It never writes a sentence for you.
> - It never explains itself or gives advice.

`isSingleQuestion` checks four things: non-empty, no `\n`, no leading list
marker, and *exactly one `?` which must be the last character*. It never
counts sentences and never caps length. The docstring claims it decides
"whether a model output is ONE question and nothing else"; CONTEXT.md defines
the Output Gate as "one sentence, ending in `?`, no list, no trailing text".
The implementation checks for trailing text and never checks for **leading**
text.

So any amount of prose passes, as long as it is on one line and the only
question mark is the final character. Driving the real `reshape()` with a stub
model (`.bughunt/probe14.ts`):

```
PASSED GATE [REWRITES THE WRITER'S SENTENCE]
  -> Try this instead: "She lifted the skillet by the wrist, a flick so offhand
     the iron seemed to weigh nothing at all." Does that land better for you?

PASSED GATE [GIVES ADVICE THEN ASKS]
  -> Your verbs are doing too little here. Cut "looked careless" and let the
     flick carry it; adverbs like this dilute a strong image. What would the
     skillet feel like to her wrist?

PASSED GATE [LONG ESSAY THEN ASKS]   (2708 chars)

PASSED GATE [LEGITIMATE ONE-LINER]
  -> What does the heavy iron skillet weigh in her wrist?
```

The first case is the product's one prohibition — a rewritten version of the
writer's own sentence, handed back to them. It passes the gate, is labelled
`source: 'reshaped'`, and is pinned into the draft as a note. Nothing
downstream truncates: `HighlightOverlay` renders `note.question` whole.

The grounding predicates do not help. `isGrounded` *wants* overlap with the
draft, and a rewrite of the writer's sentence has maximal overlap.
`echoesText` only fires above 50 % shared bigrams, which a rewrite dodges by
changing words. `copiesSeed` compares against the seed, not the draft.

The same gate is the whole of the BYOK pipeline (`web/byok.ts` calls the
identical `reshape`), so this is the browser path too.

Why it matters: every other safeguard in this codebase is real and carefully
built. This one is load-bearing for the product's central promise and is four
lines of `?`-counting. A small local model that rambles — the exact failure
mode small models have — walks straight through it.

Fix direction: reject output with sentence-terminating punctuation (`.`, `!`,
`?`) anywhere but the final character, and cap length.

---

## ~~S1-1 — A save with no store reports "Saved" and throws the draft away~~
**Fixed 2026-08-24** — same fix as first-hunt #2 above.

`web/save-coordinator.ts:88` and `:127`

*(Same bug as first-hunt #2; recorded here with its measured trace.)*

```ts
await this.store?.save(payload.draft, payload.notes);
if (this.pending === payload) {
  this.pending = null;                    // payload dropped
  this.options.onSaveState?.('saved');    // and the UI says it landed
}
```

Probe (`.bughunt/probe4.ts`), using exactly EditorApp's `getStore: () =>
draftStoreRef.current` while that ref is null:

```
events: [ 'state:saving', 'state:saved' ]
pending after null-store save: null
=> payload discarded and reported as saved? true
```

The `'saved'` pulse is what makes this worse than plain loss: `EditorApp`
stamps `setSaveTime(new Date())` on it and the topbar renders `Saved HH:MM`.
The writer is told their text is safe.

The window is real — `edit()` debounces 1 s, which is exactly the `/health`
timeout, and `persistNow()` (the note-reconcile path) fires immediately with
no debounce at all.

---

## ~~S1-2 — One failed ask makes a sweep burn the whole remaining plan, then bin every result~~
**Fixed 2026-08-24** — abort latch stops new claims after first throw; failed slot marked resolved so drain advances. Probe now: 2 of 6 asks, later notes delivered. Evidence: coach-sweep 40 passed.

`web/coach-sweep.ts` — the worker pool and `drain()`

Two faults compound:

1. **The pool does not stop on failure.** `Promise.all` rejects as soon as the
   first worker's ask throws, so `runSweep` rejects and `EditorApp`'s `finally`
   sets `sweeping = false` and hides the **Stop** button. The *sibling* worker
   is never told. It keeps claiming windows and issuing asks against a server
   that just failed — with no control left on screen to stop it.

2. **Nothing it produces survives.** `drain()` only emits the consecutive
   resolved prefix, and the window that threw never sets
   `resolved[index] = true` (the throw is before that line). The drain pointer
   parks at the failed index forever and every later note is silently dropped.

Probe (`.bughunt/probe6.ts`) — a 6-window plan where only ask #1 throws:

```
plan windows: 6
runSweep rejected: server down
total asks issued: 6 of a 6 -window plan
notes emitted: []
```

All six asks issued. Zero notes reached the caller.

In **BYOK** mode every one of those asks is billed to the writer's own API key
and every one is discarded before it can become a note. The module docstring
says "a failing ask still rejects the sweep mid-way, with the notes so far
discarded" — it does not say the sweep keeps *spending* after it has already
reported failure.

Fix direction: latch an abort on the first throw so no worker claims a new
window, and mark the failed slot resolved so the drain prefix can advance.

---

## ~~S1-3 — Killing the server orphans the STT worker and its loaded model~~
**Fixed 2026-08-24** — `registerShutdownHandlers` calls stt dispose() then exits, double-invocation guarded. Evidence: server.wiring 12 passed via injected process shim.

`src/server.ts` (no signal handlers anywhere) / `src/stt/client.ts` (`dispose`)

`createSttClient` spawns the sherpa-onnx worker lazily and exposes `dispose()`
to kill it. **Nothing ever calls `dispose()`.** `grep -rn
"SIGINT\|SIGTERM\|process.on(" src/ web/ scripts/*.ts` returns nothing but
stdio wiring — the server registers no shutdown hook at all.

Measured: after one `/transcribe`, then `kill -TERM` on the server —

```
--- worker after server death ---
149713 npm exec tsx …/src/stt/worker.ts
149725 sh -c "tsx" …/src/stt/worker.ts
149726 node …/node_modules/.bin/tsx …/src/stt/worker.ts
149737 node --require …/preflight.cjs … …/src/stt/worker.ts
```

Four processes survive, holding the Parakeet TDT weights resident. Every
`npm start` / Ctrl-C cycle leaks another model process; `tsx watch` (the
`dev:server` script) restarts on every file save.

The kill path itself is sound — SIGKILL on the direct child took the whole
chain down when I did it by hand. The only thing missing is a
`process.on('SIGINT'|'SIGTERM', …)` that calls it.

---

## ~~S2-1 — Block offsets are wrong for every CRLF document~~
**Fixed 2026-08-24** — rawEnd tracks source positions; CRLF slice round-trips byte-exact per probe. Evidence: text-window 24 passed.

`web/text-window.ts` — `splitBlocks`'s `close()`

`close()` computed `end: current.start + text.length`, where `text` is the
block's lines joined with `'\n'` — but the CR was already stripped, so a
multi-line block's `end` is short by one character per line break in the
source.

Probe (`.bughunt/probe1.ts`) on `'Alpha line one\r\nAlpha line two\r\n\r\nBeta block\r\n'`:

```
{"text":"Alpha line one\nAlpha line two","start":0,"end":29,
 "slice":"Alpha line one\r\nAlpha line tw"}
```

`draft.slice(block.start, block.end)` is **not** `block.text`. It cuts a
character short, and every following block inherits the drift.

Why it matters: those offsets are the anchor coordinate system. They feed
`SweepWindowPlan.bounds`, which `runSweep` uses to decide whether an answer
anchored inside its own window, and `cursorEnvelope` in `anchor.ts`. A draft
pasted from Windows mis-anchors throughout — notes land a character early and
drift further down the page.

> Being fixed in the working tree as of this writing: `splitBlocks` now tracks
> a separate `rawEnd`.

---

## ~~S2-2 — Setext headings are invisible to the section splitter~~
**Fixed 2026-08-24** — SETEXT_UNDERLINE_RE plus standalone thematic-break branch (ambiguity rule kept). Setext doc now 2 sections. Evidence: text-window 24 passed.

`web/text-window.ts` — `HEADING_RE`, `partitionSections`

`HEADING_RE` only matched ATX (`# Title`). A setext heading — `Title` on one
line, `====` or `----` underneath — is one of the two heading forms in every
Markdown dialect the app renders (react-markdown handles it in the preview
pane). `splitBlocks` folded both lines into a single **paragraph**, so
`partitionSections` never saw a boundary.

Probe (`.bughunt/probe1.ts`):

```
[["paragraph","Chapter One\n==========="],
 ["paragraph","Body paragraph here."],
 ["paragraph","Another\n-------"],
 ["paragraph","More body."]]
sections: 1
```

Four blocks, two headings, **one** section. And the consequence, from the
planner audit (`.bughunt/probe15.ts`):

```
setext doc: 5 blocks, 1 sections, 1 windows
```

Two chapters in a single ask. CONTEXT.md defines Text Window as "Stops at
section boundaries; never reaches past one."

The same fault swallowed a thematic break glued to a paragraph
(`Some text\n---\nMore text` → one paragraph block, one section), while a break
surrounded by blank lines split correctly.

> Being fixed in the working tree: `SETEXT_UNDERLINE_RE` plus a standalone
> thematic-break branch.

---

## ~~S2-3 — Sentence statistics are wrecked by apostrophes and inline quotes~~
**Fixed 2026-08-24** — lookbehind requires a terminator before trailing quotes. Probe: possessive prose mean 2.80→4.67 matching clean text. Evidence: window-stats 41 passed.

`web/window-stats.ts` — `splitSentences`

```ts
prose.split(/(?<=[.!?"'”’])(?:\s+|$)/)
```

The lookbehind treated **any** apostrophe or quote mark before whitespace as a
sentence end. Plural possessives (`the writers' guild`) and quoted words
mid-sentence both split a sentence in two.

Probe (`.bughunt/probe3.ts`), same prose with and without possessives:

```
possessive apostrophe => mean 2.80  sigma 1.17
no apostrophe         => mean 4.67  sigma 0.47
inline quote          => mean 7.00  sigma 4.00   (true length: 13 words)
```

A 40 % deflation of `sentenceMean` from punctuation alone.

Why it matters: the `rhythm` axis fires on `sentenceMean > 30 && sigma < 12`.
Dialogue-heavy fiction is the prose most full of quote marks and possessives —
precisely the prose whose long-sentence monotony the axis is meant to catch —
and its measured mean is pushed *down*, so `rhythm` can never fire there. The
axis then feeds `implVerbs` → `--lean-verbs` → which seed the writer is shown.

> Being fixed in the working tree: the lookbehind now requires a terminator
> before the quote (`(?<=[.!?][”’"']*)`).

---

## ~~S2-4 — The `-ly` adverb test flags ordinary nouns~~
**Fixed 2026-08-24** — NON_ADVERB_LY exclusion table. Probe adverbRate 69.2→0.0, 'quickly' still counts. Evidence: window-stats 41 passed.

`web/window-stats.ts` — the adverb/hedge loop

```ts
if (Object.hasOwn(HEDGES, lower) || (w.length > 3 && lower.endsWith('ly')))
```

Any word over three letters ending in `ly` counted as an adverb: *family,
reply, supply, holy, folly, Italy, rally, ugly, only, apply, imply, belly,
July*.

Probe (`.bughunt/probe3.ts`):

```
'The family reply was only a supply of holy folly. Italy rally ugly.'
adverbRate 69.2   axes [ 'hedge' ]
```

Sixty-nine per cent "adverbs", zero actual adverbs. The `hedge` axis fires at
a threshold of 4 %.

> Being fixed in the working tree: a `NON_ADVERB_LY` exclusion table.

---

## ~~S2-5 — The passive-voice proxy matches `was red`~~
**Fixed 2026-08-24** — minimum participle length + STATIVE_ED table. Probe nominalRate 33.3→0.0; genuine passives still count. Evidence: window-stats 41 passed.

`web/window-stats.ts` — `PASSIVE_PROXY_RE`

```ts
const PASSIVE_PROXY_RE = /\b(?:was|were)\b\s+\w+ed\b/i;
```

`\w+ed` matches any word ending in the letters `ed`, including three-letter
adjectives. `was red`, `were fed`, `was bed` all read as passive, as does every
`was tired` / `were bored` / `was scared` — predicate adjectives, not passives.

Probe (`.bughunt/probe3.ts`):

```
'She was tired. He was bored. They were scared. It was red.'
nominalRate 33.3   axes [ 'nominal' ]
```

Four false positives out of four sentences; the `nominal` axis fires at 5 %.

> Being fixed in the working tree: `([a-z]{2,}ed)` plus a `STATIVE_ED`
> exclusion table.

---

## ~~S2-6 — BYOK dictation uploads WebM bytes named `dictation.wav`~~
**Fixed 2026-08-24** — BYOK path decodes to mono-16k and encodes real RIFF/WAV before upload; docstring corrected. Evidence: byok 31 passed incl. converted-blob assertions.

`web/EditorApp.tsx` (recorder `onstop`) / `web/byok.ts` (`transcribeWavByok`)

```ts
void (modeRef.current === 'local' ? transcribeAudio(blob) : transcribeWavByok(blob))
```

`blob` is whatever `MediaRecorder` produced — `audio/webm;codecs=opus` on
Chromium, `audio/mp4` on Safari. The **local** branch converts it:
`transcribeAudio` runs `decodeToMono16k` then `encodeWavPcm16`. The **BYOK**
branch does not. It hands the raw recorder blob to `transcribeWavByok`, which
appends it as:

```ts
body.append('file', wav, 'dictation.wav');
```

The filename and the function name both claim WAV while the bytes are WebM.
`byok.ts` even documents "The local server route expects this exact
encoded-WAV shape; BYOK points the same bytes at the provider" — the two paths
do not in fact send the same bytes.

OpenAI and Groq sniff by extension as well as content; a `.wav` file that is
not RIFF is rejected or mis-decoded. BYOK dictation is broken for every
provider, and the writer is billed for the failed request.

> Being fixed in the working tree: `byok.ts` now imports `decodeToMono16k` and
> `encodeWavPcm16` from `./dictation`.

---

## ~~S2-7 — The hosted demo pins craft questions to single, meaningless words~~
**Fixed 2026-08-24** — anchor floor: single-word candidates need >=4 chars and must not be generic-table words; tier-0 quotes unaffected. Measured: junk singles -72% ('first/one/let' class eliminated), distinctive words still anchor. Evidence: anchor 19 passed + probe-s27 measurement.

`web/anchor.ts` (`findCandidates` candidate lengths) and
`web/EditorApp.tsx` (`askCursorWindow`)

In static mode the "question" is a bundled seed verbatim — a generic craft
prompt written about no particular draft. `askCursorWindow` still runs it
through `extractAnchor`, which happily matches a run of **one** distinctive
word: `findCandidates` loops `for (let len = 1; len <= maxLen; len++)` and
there is no minimum-quality floor at any tier.

Measured against the shipped sample draft, 4000 draws
(`.bughunt/probe12.ts`):

```
anchored draws:        2400 of 4000   (60%)
single-WORD anchors:   2369           = 98.7% of anchored
fragments <= 5 chars:  2037           = 84.9%
median fragment chars: 4

top anchors the demo pins:
   210x "first"   177x "one"    119x "time"   118x "let"
   112x "voice"   105x "word"   101x "use"     90x "line"
```

So the writer sees the word **"let"** highlighted in their prose with
*"Introduce your characters before the catastrophe: let readers know the…"*
attached — a question about nothing they wrote, pinned to a word chosen
because it happened to appear in both strings.

This is the GitHub Pages demo, the app's front door, and the README promises
"In the no-model demo, questions still arrive on their own after a pause."
They arrive; they are noise.

*(I first recorded this as a guess that static auto-ask produces* nothing.
*The measurement says the opposite and is worse: it produces plenty, all
junk.)*

Beyond static: the quality floor is missing from `anchor.ts` itself, so a
reshaped question sharing only a common word with the draft anchors just as
badly. `src/gate.ts:isGrounded` already insists on a 4-char overlap for model
output — the anchor tiers enforce nothing. Related: first-hunt #14.

---

## ~~S2-8 — The two DraftStore adapters disagree about what `save(draft)` means~~
**Fixed 2026-08-24** — both adapters now KEEP existing notes when omitted; floating promise awaited. Evidence: draft-store 17 passed ('keeps server annotations when save omits notes').

`web/draft-store.ts` — `LocalStorageDraftStore.save` vs `ServerDraftStore.save`

Same interface, opposite semantics for the same call:

```ts
// LocalStorageDraftStore
if (notes !== undefined) this.saveAnnotations(notes);   // omitted -> KEEP existing notes

// ServerDraftStore
const annotations = notes ?? [];                        // omitted -> WIPE existing notes
```

Both behaviours are documented, each in its own adapter's comment, which is
how the contradiction survived. `DraftStore` is a seam whose whole point is
that callers need not know which adapter they hold — and `makeDraftStore(mode)`
hands them a different one depending on whether a local server answered
`/health`.

No caller relies on the difference today (`SaveCoordinator` always passes
notes), so this is latent — but it is a trap for the next caller, and the
failure mode on the server side is silent note loss. Pairs with first-hunt
#12, which is the same seam from the other side.

Related, same file: `LocalStorageDraftStore.save` calls
`this.saveAnnotations(notes)` without `await` — a floating promise inside an
`async` method.

---

## ~~S2-9 — CI builds and deploys, but never runs the tests~~
**Fixed 2026-08-24** — deploy.yml gates Pages on `npm run typecheck && npm test` before build.

`.github/workflows/` — one workflow, `Deploy to GitHub Pages`:

```yaml
      - run: npm ci
      - run: npm run build
      - uses: peaceiris/actions-gh-pages@v4
```

`npm test` and `npm run typecheck` both exist in `package.json` and both pass,
and `README.md` tells contributors to "Run `npm test && npm run typecheck`
before you open a pull request" — but nothing enforces it. Every push to
`main` deploys straight to Pages whether or not the 377 tests pass.

This is the reason a bug hunt was worth running at all: the suite is green and
the suite is never consulted.

---

## ~~S2-10 — The README's "seven signals" cannot all fire, and fire not at all in BYOK~~
**Fixed 2026-08-24 (user decision)** — /ask derives a PositionContext so opening-/closing-position axes fire locally; README now states BYOK draws unmeasured genre-stratified seeds. Evidence: server.wiring tests assert both axes.

`src/server.ts` (`/ask`), `web/byok.ts` (`ByokCoach.ask`),
`web/window-stats.ts` (`measureWindow`)

README, *How one question gets chosen*: "Seven signals can fire: … and whether
the paragraph **opens or closes its section**."

`measureWindow(rawWindow, positionContext?)` only adds `opening-position` /
`closing-position` when a `PositionContext` is supplied. The `/ask` handler
supplies none:

```ts
const leanVerbs = implVerbs(measureWindow(textWindow));
```

Its own comment admits it — "Positional axes are silently absent". So in local
mode five of the seven signals exist.

In **BYOK** mode none do. `ByokCoach.ask` is:

```ts
const seedQuestion = pickSeed(this.seeds, genre).question;
```

No `measureWindow`, no `SeedPreference` — the measurement machinery is skipped
entirely and the draw is the plain genre-stratified lottery. The README's
table presents "Your own key" as "The same" as a local model.

Three surfaces disagree: the README (seven), the server (five), BYOK (zero).

---

## ~~S2-11 — Two thirds of the JavaScript bundle is the seed bank~~
**Fixed 2026-08-24** — lazy `loadSeeds()`; bank lands in its own chunk (397 kB, main chunk seed-free, 0/200 sampled ids in main). Evidence: vite build inspection reported in EditorAppBehaviors run.

`web/coach.ts` — `import clientJson from '../seeds/client.json'`

```
seeds/client.json                    479,215 bytes
dist/assets/index-IGyEmE-e.js        859,019 bytes
  first seed id at byte              295,929
  distinct seed ids embedded           1,709
```

The entire 1,757-seed bank is inlined into the main chunk, so ~563 KB of the
859 KB a first-time visitor downloads is a bank from which exactly one seed
will be read per ask. `StaticCoach.ask` calls `pickSeed(this.seeds, genre)` —
one draw.

The project already knows how to split a chunk: `markdown-preview.tsx` goes to
the trouble of `React.lazy` + dynamic import specifically "so it lands in a
SEPARATE vite chunk: the main bundle stays flat". The bank — five times larger
than the renderer — is imported statically.

---

## ~~S2-12 — `isGrounded` accepts accidental substring overlap~~
**Fixed 2026-08-24** — overlap must align with a word boundary (prefix rule): time/sometimes, ring/bring rejected; walk/walked still grounded. Evidence: gate 47 passed.

`src/gate.ts` — `isGrounded`

Grounding is a substring test in either direction with a 4-character floor.
That floor stops `her` matching inside `where`, but not a short common word
matching inside an unrelated longer one. Probe (`.bughunt/probe13.ts`):

```
true   "time" matches inside "sometimes"   — "What time is it?" vs "He sometimes hesitates."
true   "ring" matches inside "bring"/"during"
false  "other" inside "brother"            (correctly rejected)
```

A question about *time* counts as grounded in a passage whose only overlap is
the word *sometimes*. Combined with S2-7 (the anchor tiers have no quality
floor either), a question can pass the grounding gate and then be pinned to a
word it never meant.

---

## ~~S3-1 — "Saving…" sticks forever after a save fails~~
**Fixed 2026-08-24** — SaveIndicator gains saveFailed(); wired from onError in EditorApp. Evidence: save-indicator 11 passed.

`web/save-indicator.ts`

`SaveIndicator` has `saveStarted()` and `saveSucceeded()` and **no failure
input**. `SaveCoordinator` only calls `onSaveState('saving')` before the
attempt and `'saved'` on success — a failure routes to `onError` instead,
which `EditorApp` renders as a separate toast.

So after a failed save the 400 ms pending timer fires, sets `'saving'`, and
nothing ever moves it: the topbar reads **Saving…** for the rest of the
session, until the next successful save.

Complements first-hunt #3: that entry is the store failing to report failure;
this one is the indicator having nowhere to put a failure even if it were
reported.

---

## ~~S3-2 — A stale debounce handle can be nulled out and leak~~
**Fixed 2026-08-24** — per-schedule handle capture; each timer clears only itself; clearTimers cancels the live one. Evidence: dedicated interleave regression, coordinator 16 passed.

`web/save-coordinator.ts` — `flush()`/`trySave()` `finally` blocks and `edit()`

`handleContentChange` calls `coordinator.persistNow(...)` and then
`coordinator.edit(...)` synchronously:

1. `persistNow` sets `pending = P1` and awaits `flush()`, which captures
   `payload = P1` and yields on the network.
2. `edit()` runs, sets `pending = P2`, and stores its timer in
   `this.debounceTimer` (call it **T1**).
3. `flush()` resolves, sees `pending !== payload`, and *overwrites*
   `this.debounceTimer` with a new timer **T2** — T1 is never cleared and is
   now unreachable.
4. T1 fires and its callback runs `this.debounceTimer = null`, which nulls the
   handle for **T2**, not itself.

Net: one orphaned timer per occurrence, and `clearTimers()` can no longer
cancel T2. The observable damage is small today (the second `trySave()` finds
`pending === null` and returns) but the bookkeeping is wrong, and the class's
stated contract is "any pending timer is cleared before a new one is
scheduled".

---

## ~~S3-3 — `anchor.ts`'s quote scan documents "longest" but implements "nearest"~~
**Fixed 2026-08-24** — inner scan keeps the longest span per opening mark (tie: earlier start); cursor-proximity per needle preserved. Evidence: anchor tests incl. possessive-quote case.

`web/anchor.ts` — the Tier-0 verbatim-quote scan

The comment states: "the inner scan keeps extending past each successful
closing mark, **keeping the longest match** for this opening quote — so an
apostrophe inside the quoted text ("the writer's words") can't truncate it."

The code selects by distance to the cursor, not by length:

```ts
if (bestForThisOpen === null || dist < bestDist || (dist === bestDist && p < bestForThisOpen.start)) {
```

Only the *outer* loop (across opening marks) compares `span`. Within one
opening quote a shorter, cursor-nearer candidate wins over a longer one, so
the stated no-truncation guarantee is not what the code enforces. (The
specific apostrophe case in the comment happens to be safe for a different
reason — the `isLetter` flanking test rejects `writer's` as a closing mark.)

Either the comment or the selection rule is wrong; the next person to touch
this will trust the comment.

---

## ~~S3-4 — `mayAutoAsk` allows static mode, but static mode has no way to turn it off~~
**Fixed 2026-08-24 (user decision: keep + expose)** — Auto-ask checkbox renders whenever mayAutoAsk(mode) is true, so static demo writers can switch the cadence off; stale comment corrected.

`web/coach.ts` (`mayAutoAsk`) vs `web/EditorApp.tsx` (the Auto-ask checkbox)

`mayAutoAsk` returns true for `'static'` and `'local'`. The **Auto-ask**
checkbox that sets `cadencePausedRef` is rendered only when
`mode === 'local'`:

```tsx
{mode === 'local' && ( <label className="cadence-toggle"> … )}
```

So in the hosted static demo the cadence timer fires every time the writer
adds 30 words and pauses 20 s, with no control anywhere on screen to stop it.
The adjacent comment asserts the opposite rule ("Auto-ask stays gated on
`mode === 'local'`, NOT modelBacked") while `mayAutoAsk` is the thing that
actually gates it, and it says otherwise. Read together with S2-7, what the
writer cannot switch off is a stream of junk anchors.

---

## ~~S3-5 — The `Host` check is case-sensitive; the `Origin` check is not~~
**Fixed 2026-08-24** — both halves lowercased before compare (layered on the port fix). Raw-socket probe: LOCALHOST authority now accepted.

`src/boundary.ts` — `LOCAL_HOSTNAMES` / `hostWithoutPort` vs `originHost`

`LOCAL_HOSTNAMES` is a lowercase `Set` and `hostWithoutPort` returns the
authority unchanged. `originHost`, by contrast, goes through `new URL(...)`,
and WHATWG URL lowercases the host. The two halves of one check normalise
differently.

Raw-socket probe (`.bughunt/probe8.mjs` — `fetch` rewrites `Host`, so this
must be done on a socket):

```
A Host: 127.0.0.1:4599                                  -> 200
D Host: LOCALHOST:4599                                  -> 403 untrusted Host "LOCALHOST:4599"
E Host: localhost:4599 + Origin: http://LOCALHOST:4599  -> 200
```

Hostnames are case-insensitive (RFC 3986 §3.2.2). D is a false rejection: the
same authority that passes as `localhost` is refused as `LOCALHOST`, and the
app is simply unreachable for whatever client sent it that way.

The rest of the boundary held under raw-socket probing — attacker Host (403),
trailing-dot Host (403), `..%2F` traversal (403), backslash traversal, null
byte, and cross-origin Origin all behaved. The port dimension (first-hunt #1)
is the real hole; this is the case dimension.

---

## ~~S3-6 — `/transcribe`'s content-type gate is satisfied by `text/plain`~~
**Fixed 2026-08-24** — media type split on ';', lowercased, anchored /^audio\/(?:wav|x-wav|wave)\b/. Evidence: server.wiring test rejects 'text/plain; charset=audio/wave' before the recognizer.

`src/server.ts` — the `/transcribe` content-type check

```ts
if (!/audio\/(?:wav|x-wav|wave)/.test(contentType)) {
```

Unanchored, so it matches the substring anywhere in the header — including
inside a parameter. Live probe:

```
POST /transcribe   Content-Type: text/plain; charset=audio/wave
-> 503  {"error":"Non-zero status code returned while running ConvInteger node…"}
```

The request passed the gate, was decoded as a WAV, and reached the recogniser.
`text/plain` is a CORS-**simple** content type, so a cross-origin POST carrying
it triggers no preflight — which makes the `Origin` check in `boundary.ts` the
*only* thing standing there. The boundary module's own docstring names this
exact scenario ("a hostile web page POSTs JSON as text/plain straight at
http://127.0.0.1:<port>"), so the intent was defence in depth; the regex does
not deliver it. Read with first-hunt #1, that single remaining layer has a
port-sized hole in it.

Anchor it (`/^audio\/(?:wav|x-wav|wave)\b/`) and parse the media type before
the parameters.

---

## ~~S3-7 — A too-short recording shows the writer a raw ONNX stack message~~
**Fixed 2026-08-24** — 0.1 s minimum recording floor returns 400 'recording too short'; recognizer failures map to human-readable text, not ConvInteger internals. Evidence: 4-sample WAV test asserts 400 + clean message.

`src/server.ts` — `/transcribe` error mapping

There is no minimum-length check on the decoded audio. A 4-sample WAV reaches
the recogniser, which fails inside the graph, and the message is handed to the
client verbatim:

```
POST /transcribe (4 samples)  -> 503
{"error":"Non-zero status code returned while running ConvInteger node.
 Name:'/pre_encode/conv/conv.0/Conv_quant' Status Message: Invalid input shape: {0,128}"}
```

`EditorApp` renders that straight into the error toast. A one-second tone
transcribes fine (200, 47 ms), so this is purely a length floor the code never
applies — a writer who taps **Dictate** and immediately taps **Stop** gets ONNX
internals on screen.

The 503 is also wrong for this case: nothing is unavailable, the input was too
short. `/transcribe` maps every post-decode failure to 503.

---

## ~~S3-8 — The STT worker is spawned with `npx tsx`, and `tsx` is a devDependency~~
**Fixed 2026-08-24** — tsx moved to dependencies; --omit=dev installs can no longer break dictation or pull tsx from the network at first use.

`src/stt/client.ts` — `createSttClient`

```ts
const tsxPath = opts?.tsxPath ?? 'npx';
const spawnArgs = tsxPath === 'npx' ? ['tsx', workerPath] : [workerPath];
```

`tsx` sits in `devDependencies`, so an install that omits dev dependencies —
`npm ci --omit=dev`, the normal way to deploy a Node service — leaves
`/transcribe` unable to start its worker. `npx` would then try to *download*
tsx from the network at first dictation, on a server whose entire premise is
that nothing leaves the machine.

It also means the worker is TypeScript compiled at runtime, on the request
path, in production.

---

## ~~S3-9 — The worker path is built from `url.pathname`, which is percent-encoded~~
**Fixed 2026-08-24** — fileURLToPath round-trip; space paths spawn literally (first-hunt #17's pathname half).

`src/stt/client.ts`

```ts
const workerPath = opts?.workerPath ?? new URL('./worker.ts', import.meta.url).pathname;
```

`URL.pathname` keeps percent-encoding: a checkout under a directory with a
space becomes `…/better%20writer/src/stt/worker.ts`, which `spawn` passes
through literally and the file is not found. On Windows it yields a leading
slash (`/C:/…`). `fileURLToPath` exists for exactly this and is already
imported two modules over (`src/server.ts`, `src/seed.ts`).

---

## ~~S3-10 — Writing to the worker's stdin has no error handler, and `transcribe()` has no timeout~~
**Fixed 2026-08-24** — stdin 'error' routes to failOutstanding(); transcribe() carries a 120 s timeout that settles as transport failure and reaps a hung worker.

`src/stt/client.ts` — `sendInbound` / `ensureSpawned`

```ts
function sendInbound(msg: string): void {
  const proc = ensureSpawned();
  proc.stdin!.write(`${msg}\n`);
}
```

`ensureSpawned` returns the cached child when `child && !child.killed` — and
`killed` is only true if *we* called `kill()`. A child that crashed on its own
(the module docstring warns sherpa's "NAPI finalizer can segfault") has
`killed === false` until the `'exit'` event is delivered, so a write landing in
that gap goes to a dead pipe. Nothing registers `child.stdin.on('error')`, and
`child.on('error')` covers spawn failures, not stream errors — so an EPIPE
surfaces as an unhandled `'error'` event, which takes the whole server process
down.

Same area: `transcribe()` has **no timeout**. If the worker hangs (a model load
that never completes), the returned promise never settles, and `/transcribe`
has no timeout either, so the HTTP request hangs until the client gives up. The
only thing that can settle it is the worker exiting.

---

## ~~S3-11 — A malformed `audio` message hangs the stream instead of failing it~~
**Fixed 2026-08-24** — decode moved inside try in the streaming branch; base64ToFloat32 rejects non-multiple-of-4 payloads; stream-error now always answers. Evidence: 5-byte payload test settles.

`src/stt/worker.ts` — `handle()`

```ts
if (msg.type === 'audio') {
  const samples = base64ToFloat32(msg.samples);   // <- outside any try
  await pushAudio(msg.id, samples, msg.sampleRate);
```

`base64ToFloat32` does `new Float32Array(buf.buffer, buf.byteOffset,
buf.byteLength / 4)`, which throws a `RangeError` when the payload's byte
length is not a multiple of four. The throw escapes `handle()` into the
queue's `.catch`, which only logs — so no `stream-error` is ever sent and the
parent's `pendingEnd` promise never settles.

The one-shot `transcribe` branch does the same decode *inside* a `try` and
answers with an `error` message. Only the streaming branch leaks.

---

## ~~S3-12 — An explicitly set but incomplete `BW_STT_MODEL_DIR` is silently ignored~~
**Fixed 2026-08-24** — resolveModelDir warns once naming both the ignored env dir and the cache actually used; resolution order unchanged.

`src/stt/model.ts` — `resolveModelDir`

```ts
const envDir = process.env['BW_STT_MODEL_DIR'];
if (envDir && dirHasAllFiles(envDir)) return envDir;
const cacheDir = resolveCacheDir();
if (dirHasAllFiles(cacheDir)) return cacheDir;
```

Setting the variable to a directory missing one of the four model files falls
through to the cache without a word. The operator who pointed it at a
half-downloaded folder gets transcription from a *different* model than the one
they named, or the generic "model not found" error naming a cache path they
never mentioned.

Relatedly the README's settings table says `BW_STT_MODEL_DIR` "unset →
dictation is off without it". That is false: the cache fallback is the normal
path. My live probe transcribed successfully with the variable unset.

---

## ~~S3-13 — `isSingleQuestion` rejects a question that quotes a question~~
**Fixed 2026-08-24** — quoted ? exempt (speech, not sentence), apostrophe guard, em/en/plus bullets rejected, leading decor stripped, fullwidth ？ equivalent. Evidence: gate table cases all pinned.

`src/gate.ts`

The rule is "the only `?` in the string is the last char", so a perfectly
formed coach question that quotes the writer's own question mark fails:

```
false  You wrote "why?" — what does she mean?
```

That is exactly the shape the prompt asks the model to produce — "quote the
writer's exact words". A draft containing a question therefore burns the retry
and lands on a topic probe.

Two smaller misses in the same predicate (`.bughunt/probe13.ts`):

```
true   — Which verb is doing the work?      (em-dash bullet; the list check
                                             covers -, *, •, N. but not — or +)
true   "1. What is at stake?                (a leading quote defeats the ^ anchor)
false  What is at stake？                   (fullwidth ？ is not a '?')
```

---

## ~~S3-14 — `staleAnnotations` keeps empty-fragment notes its docstring says it drops~~
**Fixed 2026-08-24** — up-front guard drops empty/degenerate spans before the exact-offset identity check; code matches docstring. Evidence: coach-sweep 40 passed.

`web/coach-sweep.ts` — `staleAnnotations`

The docstring: "An annotation is dropped only when its fragment no longer
exists in the draft, **is empty**, or has two occurrences equidistant…"

The empty check sits *after* the exact-offset check:

```ts
if (annotation.start >= 0 && annotation.end <= draft.length &&
    draft.slice(annotation.start, annotation.end) === annotation.fragment) {
  return [annotation];        // '' === '' -> an empty note always survives here
}
if (!annotation.fragment) return [];   // never reached for a valid [n,n) span
```

Probe (`.bughunt/probe16.ts`): `{start:0, end:0, fragment:''}` →
`out 1, changed=false`. The note survives every edit forever.
`buildHighlightSet` then drops it (`start >= end`), so it is invisible in the
editor but still occupies a row in the **InboxPanel** with a blank fragment,
and still rides along in every `/save`.

Reachable via a hand-edited `data/annotations/current.json` or
`better-writer:annotations` — neither store validates on read (S3-15,
first-hunt #13).

---

## ~~S3-15 — The browser store validates nothing on read; the server validates everything on write~~
**Fixed 2026-08-24** — parseNote/sanitizeNotes guards on both adapters plus shape guard in src/draft.ts loadAnnotations (#13). Malformed entries skipped, never cast through.

`web/draft-store.ts` (`loadAnnotations`) vs `src/server.ts` (`parseAnnotation`)

The server has a careful `parseAnnotation`: it checks the type of every field
and rejects the whole note rather than silently stripping an invalid `source`.
The browser store, holding the same wire shape, has:

```ts
const parsed: unknown = JSON.parse(raw);
return Array.isArray(parsed) ? (parsed as Note[]) : [];
```

An array of anything is cast to `Note[]`. `ServerDraftStore.loadAnnotations` is
no better — `src/draft.ts` does `JSON.parse(...) as Annotation[]` on the read
path, so `/load` returns whatever is in the file (first-hunt #13 covers the
non-array case; this covers the array-of-garbage case).

`staleAnnotations` happens to filter the worst of it (a note with `undefined`
offsets fails `start >= 0` and then `!annotation.fragment`), so I could not
drive a crash through the load path. But the clamp meant to be the last line of
defence does not hold either — see S4-11.

---

## ~~S3-16 — Adopting or disconnecting BYOK loads the draft twice~~
**Fixed 2026-08-24** — same fix as first-hunt #11 above (effect is the sole loader).

`web/EditorApp.tsx` — `saveByokSettings`, `disconnectByok`, and the `[mode]` effect

*(Same as first-hunt #11.)* `saveByokSettings()` calls `setMode('byok')` and
then `loadDraftAndNotes(...)` directly; the `useEffect` keyed on `[mode]` also
calls it when the mode changes. Both fire; the `loadSeqRef` guard makes the
second win, so nothing breaks — but the store is read (and, for a server store,
fetched) twice per adoption. `disconnectByok()` has the same shape.

---

## ~~S4-1 — `planSweep` runs over the whole draft on every render~~
**Fixed 2026-08-24** — sweepEstimate memoized ([mode, draft, sweeping]); byokCfg memoized with an invalidation version instead of per-render localStorage parse.

`web/EditorApp.tsx` — `sweepEstimate`

```ts
const sweepEstimate =
  isModelBacked(mode) && draftRef.current.trim() !== '' && !sweeping ? planSweep(draftRef.current).length : 0
```

`planSweep` calls `splitBlocks` over the entire document, and this sits in the
render body — so it runs on every keystroke (each keystroke calls `setDraft`).
The comment claims "planSweep is pure and fast, so an inline per-render
computation is acceptable"; pure it is, but it is O(document) and it is on the
typing hot path, which is the one path this codebase otherwise works hard to
keep clear (see the preview-debounce rationale in `markdown-preview.tsx`).

Same shape, smaller cost: `dictationAvailable` calls `loadByokConfig()` — a
`localStorage` read plus `JSON.parse` — every render.

---

## ~~S4-2 — `rectForRange` does not clamp, unlike every other offset consumer~~
**Fixed 2026-08-24** — clamps to [0, docLength]; empty-after-clamp → null (consumer tolerates). Evidence: editor-access 26→27 passed, beyond-doc regression.

`web/editor-access.ts` — `rectForRange`

`buildHighlightSet` clamps span offsets to `[0, docLength]` precisely because
"a stray value must not crash the editor". `rectForRange` guards only
`from >= to` and then calls `view.coordsAtPos(from)`, which throws a
`RangeError` for a position past the document end. `HighlightOverlay` calls it
from a layout effect with note offsets that can be one render stale.

---

## ~~S4-3 — Inbox rows are clickable `div`s with no keyboard path~~
**Fixed 2026-08-24** — row body is a native <button type=button> inside the listitem wrapper; Enter/Space work natively. Evidence: inbox-panel 5 passed.

`web/inbox-panel.tsx`

```tsx
<div key={…} className="inbox-row" role="listitem" onClick={() => onFocusNote(note)}>
```

`role="listitem"` is not interactive: no `tabIndex`, no key handler, no button
role. A keyboard user can reach the per-row **Resolved** button but can never
jump the editor to a note's span. Every other control in the app is a real
`<button>`.

> Being fixed in the working tree: the row body is becoming a real `<button>`.

---

## ~~S4-4 — `markdown-preview.test.tsx` costs 40 s of a 41 s suite~~
**Fixed 2026-08-24** — waits outside act() for real commits + fake timers only for the debounce advance. Suite wall: 40.8 s → 0.77 s, assertions unchanged.

```
✓ web/markdown-preview.test.tsx (4 tests) 40366ms
   ✓ renders headings, paragraphs, links, and a GFM table  10029ms
   ✓ renders raw HTML as inert text, never injecting elements  10013ms
   ✓ preserves data:image URIs …  10015ms
   ✓ debounces live updates …  10309ms
```

Four tests, ten seconds each, against a component whose only delay is a 250 ms
debounce — each test is evidently waiting out a default timeout rather than the
thing it measures. The other 24 files together take under a second.

---

## ~~S4-5 — A CodeMirror view outlives its test and throws after teardown~~
**Fixed 2026-08-24** — trackAccess helper detaches every view in afterEach; vitest output greps zero Unhandled/Uncaught.

`web/editor-access.test.ts` (surfaced during the baseline run)

```
TypeError: this.win.requestAnimationFrame is not a function
 ❯ EditorView.requestMeasure @codemirror/view/dist/index.js:8326
 ❯ Timeout._onTimeout @codemirror/view/dist/index.js:5239
This error originated in "web/editor-access.test.ts" … caught after the
test environment was torn down.
```

Vitest reports it as an unhandled error and warns it "might cause false
positive tests". A view is left attached when a test ends: CM6's internal timer
fires against a torn-down jsdom window. The suite still reports green, which is
the part worth fixing — an unhandled error should not be able to hide behind a
passing run.

---

## ~~S4-6 — `src/classify.ts` is dead code with a dedicated test file~~
**Fixed 2026-08-24 (deleted)** — classify.ts + classify.test.ts removed (user-approved cleanup pass).

`src/classify.ts` (108 lines), `src/classify.test.ts` (139 lines)

```
$ grep -rn '\bclassifyVerbs\b' src web scripts --include='*.ts*' | grep -v '\.test\.'
src/classify.ts:71:export async function classifyVerbs(
$ grep -rn 'classify' src web scripts --include='*.ts*' | grep -v 'src/classify'
(nothing)
```

The verb-classifier LLM pass has no caller. The server chose the measured route
instead (`implVerbs(measureWindow(...))`). 247 lines are maintained,
typechecked and tested on every run for a path that cannot execute.

---

## ~~S4-7 — The draft backup feature exists and is switched off in production~~
**Fixed 2026-08-24 (user decision)** — defaultDraftIo passes backupEveryNthSave: 1; every save rotates ${draft}.backup first.

`src/draft.ts` — `DraftIoOptions.backupEveryNthSave`, `maybeBackup`,
`defaultDraftIo`

`backupEveryNthSave` implements rotation to `${draft}.backup` with careful
handling for "nothing on disk yet" and "content unchanged". The production
instance is:

```ts
export const defaultDraftIo = createDraftIo(DRAFT_FILE, ANNOTATIONS_FILE);
```

No options, so `maybeBackup` returns on its first line every time. Only
`draft.test.ts` ever passes the flag.

Worth pairing with S1-1 and first-hunt #2/#3: the codebase has a written answer
to "what if we lose the writer's draft" and production never turns it on.

---

## ~~S4-8 — The whole STT streaming half is unreachable~~
**Dispositioned 2026-08-24 (user decision: keep and fix)** — surface retained; every bug living inside it fixed (#15, #16, S3-9..S3-11 above). Revisit deletion if it stays caller-less next hunt.

`src/stt/client.ts` (`openStream`, `StreamState`, partial/error subscriber
sets), `src/stt/protocol.ts` (`StreamOpenMsg`, `AudioMsg`, `StreamEndMsg`,
`StreamReadyResp`, `PartialResp`, `StreamErrorResp`), `src/stt/worker.ts`
(`openStream`, `pushAudio`, `endStream`, the pseudo-streaming engine).

`SttClient.openStream` has no caller outside its own definition — the server
uses only the one-shot `transcribe`, and nothing in `web/` knows the streaming
protocol exists. Roughly 150 lines of cross-process protocol, plus the worker's
documented pseudo-streaming design (a 20-line header explaining why the offline
Parakeet model must re-decode the whole buffer per chunk), maintained for a
path nothing enters.

---

## ~~S4-9 — Invalid JSON on `/save` is reported as "draft must be a string"~~
**Fixed 2026-08-24** — parse failure says 'invalid JSON body'; wrong-type field keeps the old message. Evidence: server.wiring assertions on both paths.

`src/server.ts` — the `/save` handler

```ts
const body = await c.req.json<…>().catch(() => null);
const draft = body?.draft;
if (typeof draft !== 'string') return c.json({ error: 'draft must be a string' }, 400);
```

A parse failure collapses into the same message as a well-formed body with a
numeric `draft`. Live probe: `POST /save` with body `not json` →
`400 {"error":"draft must be a string"}`. The draft was never read.

---

## ~~S4-10 — `node-compile-cache/` is 2.8 MB of build junk in the repo root, unignored~~
**Fixed 2026-08-24** — added to .gitignore.

`git status` shows it untracked, and `.gitignore` — which is otherwise careful,
covering `data/`, `Books/`, `.env`, `dist/`, `__pycache__/` — has no entry for
it. It is Node's V8 compile cache (`node-compile-cache/v24.14.0-x64-…`),
regenerated on every run, and one `git add -A` away from being committed.

---

## ~~S4-11 — `buildHighlightSet`'s clamp does not survive a non-number~~
**Fixed 2026-08-24** — Number.isFinite guard drops non-finite offsets before the Math.max/min clamp, so NaN can never reach RangeSet.of. Evidence: decorations/highlight suites green.

`web/decorations.ts` — `buildHighlightSet`

The module header promises the builder "Clamps defensively (offsets are assumed
remapped by reconcileAnnotations, but a stray value must not crash the
editor)." The clamp is:

```ts
const start = Math.max(0, Math.min(span.start, length));
const end   = Math.max(0, Math.min(span.end, length));
if (start >= end) continue;
```

With `undefined` or `NaN` in, both become `NaN`, and `NaN >= NaN` is **false**,
so the guard passes and a `range(NaN, NaN)` reaches `RangeSet.of`. Probe
(`.bughunt/probe17.ts`):

```
THROWS  undefined offsets -> Cannot read properties of null (reading 'endSide')
THROWS  NaN offsets       -> Cannot read properties of null (reading 'endSide')
ok      string offsets '5'/'9' -> size 1   (coerced, silently)
ok      reversed 9..4          -> size 0   (correctly dropped)
```

`showHighlights` is called from a `useEffect`, so the throw escapes into
React's commit phase. There is no error boundary in the tree (`web/main.tsx`),
which means a blank page. A `Number.isFinite` test would close it.

---

## ~~S4-12 — `scripts/k-sweep.ts` re-declares the gate pipeline it is measuring~~
**Fixed 2026-08-24** — RESHAPE_SYSTEM, RETRY_SUFFIXES and buildPrompt now imported from src/reshape.js (exported for this); gate predicates were already live imports, so hardened gate semantics flow into the experiment automatically. Local copies deleted; plural suffix stays experiment-only.

`scripts/k-sweep.ts` — `RESHAPE_SYSTEM`, `RETRY_SUFFIXES`, the four-predicate
gate sequence

The experiment runner copies `RESHAPE_SYSTEM` and `RETRY_SUFFIXES` verbatim out
of `src/reshape.ts` and re-implements `tryComplete`'s predicate sequence,
describing itself as "byte-identical to src/reshape.ts buildPrompt". I checked:
the system prompt *is* currently identical, the suffixes match, and the gate
order matches (the one deliberate difference is `copiesSeed(question,
fedJoined)` for the multi-seed arms). Nothing keeps them that way.

This matters specifically because of **S1-0**: the moment `isSingleQuestion` is
tightened, `k-sweep` keeps measuring pass rates against a gate the product no
longer uses, and the experiment's numbers quietly stop describing the product.

Third instance of the same pattern — `anchor.ts` duplicates `gate.ts`'s
STOPWORDS (with an explicit "keep the two tables in sync" comment), and
`window-stats.ts` carries a third, differently-populated STOPWORDS table.

---

## ~~S4-13 — A merged window can hold five blocks, not the documented three~~
**Fixed 2026-08-24** — Q4 tail merge adds a block-count cap (WINDOW_BLOCKS + 1); docstring updated to state it. Evidence: coach-sweep 40 passed incl. 5-block -> 2 windows.

`web/coach-sweep.ts` — the Q4 tail merge

`WINDOW_BLOCKS = 3` and the header says windows "grow up to 3 blocks or
MAX_WINDOW_CHARS … whichever binds first". The Q4 tail merge then appends a stub
of up to two blocks with only a character-budget test, no block-count test.
Probe (`.bughunt/probe15.ts`), a 5-block document:

```
setext doc: 5 blocks, 1 sections, 1 windows
```

One window, five blocks.

All other planner invariants I checked hold: no overlapping bounds, no window
spanning a section boundary, `cursorHint` always inside its own bounds, marked
text always a real slice of the draft, and an over-budget single block
correctly emitted alone.

---

## Verified-working spot checks (second hunt)

Recorded so the report shows what passed, not only what failed:

- **Boundary, raw socket:** attacker `Host` → 403, trailing-dot `Host` → 403,
  `..%2F..%2F` traversal → 403, `/../../package.json` → SPA fallback (no leak),
  backslash traversal → no leak, `%00` in path → no leak, cross-origin `Origin`
  → 403. Only the case dimension (S3-5) and the port dimension (first-hunt #1)
  are broken.
- **WAV decoder:** correctly rejects stereo, 8-bit, truncated `fmt`, and a
  missing `data` chunk; correctly clamps a `0xFFFFFFFF` declared `dataSize`;
  correctly walks a valid `LIST`/`INFO` chunk. One second of tone → `200`.
- **Sweep planner:** every structural invariant held across eight documents
  (see S4-13).
- **Annotation reconciliation:** exact hits keep object identity and report
  `changed=false`; a shifted fragment remaps to the nearest occurrence; a
  vanished fragment drops. Only the empty-fragment case is wrong (S3-14).
- **Seed bank:** `seeds/bank.sqlite` and `seeds/client.json` are in sync — 1757
  seeds each, zero ids on either side alone; verb counts match the README table
  exactly.
- **`retrieve.py`:** `pull --genre` and `pull --lean-verbs` both work end to
  end against the real bank.

---

## Note on the baseline

The second hunt's baseline was `tsc --noEmit` clean and 377/377 tests passing.
Partway through, the working tree changed underneath the hunt:
`web/anchor.ts`, `web/coach-sweep.ts`, `web/inbox-panel.tsx`,
`web/window-stats.ts`, `web/byok.ts`, `web/editor-access.ts` and
`web/text-window.ts` were edited outside that session and carried syntax errors
(literal `@@` diff markers written into `window-stats.ts`, a duplicated
`import { reshape }` in `byok.ts`, a duplicated `splitBlocks` in
`text-window.ts`), so `npm run typecheck` stopped passing.

Those edits target S1-2, S2-1, S2-2, S2-3, S2-4, S2-5, S2-6 and S4-3 — the
fixes are right, the application was partial. Entries above carry a
"> Being fixed in the working tree" note where that applies.

**Every finding above was verified against the tree as it stood before those
edits.** Nothing has been re-verified since.
