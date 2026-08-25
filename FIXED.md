# Fixed and verified — better-writer

The 56 resolutions accepted in the fix review of 2026-08-24, held against the
two-hunt report. Every entry below was fixed in commit `f37a156` and then
re-checked independently: the fix was read for substance, and where a probe
existed it was re-run against the new code. The five whose fix did NOT hold
stayed behind in [BUGS.md](BUGS.md).

**Baseline at review time:** `npx tsc --noEmit` clean; `npx vitest run` 29 files
/ 463 tests green in 0.96 s.

## What was re-verified, not just re-read

| Finding | Check | Result |
|---|---|---|
| S1-0 | `.bughunt/probe14.ts` drives the real `reshape()` | All three attack shapes (rewrite the writer's sentence, advice-then-ask, 2708-char essay) now **blocked** and fall back to a topic probe; the legitimate one-liner still passes |
| S1-1 / #2 | `.bughunt/probe4.ts` | `error: No active storage yet…`, payload **retained** in `pending`, no `'saved'` pulse |
| S1-2 | `.bughunt/probe6.ts` | 6-window plan, ask #1 throws → **2 of 6** asks issued (was 6 of 6), later note **delivered** (was zero) |
| S1-3 | Live process test: server on `BW_PORT=4599`, one `/transcribe`, `kill -TERM` | Worker chain **gone**. Was 4 surviving processes holding Parakeet weights |
| S2-1 / S2-2 | `.bughunt/probe1.ts` | CRLF slice round-trips byte-exact; setext doc splits into 2 sections |
| S2-3 | `.bughunt/probe3.ts` | Possessive prose mean 4.67 — identical to the same text without apostrophes |
| S2-9 | `.github/workflows/deploy.yml` | `npm run typecheck` and `npm test` now gate `npm run build` |
| S2-10 | `src/server.ts#derivePositionContext` | Real code fix, not a README hedge — `/ask` derives position from the window's own blocks and passes it to `measureWindow`; the docstring states its approximation honestly |
| S2-11 | `npm run build` | Seed bank is its own 397.62 kB chunk; **0** occurrences of a sampled seed id in the 467 kB main chunk |
| #6 | `web/EditorApp.tsx:869` | "Dictation model" field really renders; blank degrades to provider default |
| S4-11 | `.bughunt/probe17.ts` | undefined / string / NaN / reversed offsets all → set size 0 |
| S4-13 | `.bughunt/probe15.ts` | 8 planner shapes, 0 windows over budget, 5-block doc → 2 windows |

## Residual notes on accepted fixes

These do not overturn the fix; they are worth knowing.

- **S1-3** — `dispose()` schedules `proc.kill('SIGKILL')` at 1000 ms with
  `.unref()`, but `registerShutdownHandlers` calls `proc.exit(0)` synchronously
  in its `finally`. The timer can never fire from the signal path. The worker
  dies anyway because it handles `{"type":"shutdown"}` and exits 0 — which is
  what the live test measured — so the outcome is right, but that `setTimeout`
  reads as a safety net and is not one.
- **S1-3 / S3-8** — `tsx` moved to `dependencies` (correct), yet the worker is
  still spawned through `npx` (`src/stt/client.ts:152`), which is why the
  worker is a four-process chain. `node_modules/.bin/tsx` is now guaranteed
  present and would collapse it to one.
- **S3-14** — `staleAnnotations` drops degenerate spans up front, as the
  docstring says. Separately, `reconcileAnnotations` still keeps a note whose
  fragment happens to match at its **old** offsets after an edit moved it
  (`.bughunt/probe16.ts` case 5). That was never a recorded finding; noting it
  here so the next hunt does not re-derive it.

---

## First hunt — 2026-08-24

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

## Second hunt — 2026-08-24 (independent pass)

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


---

# Fix-review round — R1-R4 (2026-08-24)

The five resolutions that did not hold, plus the one new finding, were opened
as R1-R6. R1-R4 are code and are fixed below; R5 and R6 are README claims and
stay in [BUGS.md](BUGS.md) for the author.

Four of the five failed resolutions shared one shape: the fix was written
against the words that appeared in the probe output, not against the class the
probe sampled. So each fix here is stated with the measurement that holds it,
and each carries a regression test written over prose the fix was NOT derived
from — the only kind of test that catches a table shaped to its own probe.

| | before the round | after |
|---|---|---|
| draws that anchor (4000 fiction draws) | 690 / 4000 = 17.2 % | **2394 / 4000 = 59.9 %** |
| single-word anchors | 94.1 % of anchors | **0 %** |
| adverbRate on -ly non-adverb prose | 27-40, `hedge` fires | **0.0, axis silent** |
| nominalRate on predicate adjectives | 25.0-33.3, `nominal` fires | **0.0, axis silent** |
| grounded seed questions | 32.7 % | **33.8 %** |

Suite: 29 files / 484 tests green (was 463); `tsc --noEmit` clean.

## ~~R1 — The anchor floor suppressed anchors instead of improving them~~

**Fixed** — `web/anchor.ts`. The floor no longer discards; it RANKS. A
candidate carries a quality tier (multi-word phrase > distinctive lone word >
short-or-generic lone word) and selection runs the existing envelope /
nearest / longest policy over the strong tiers first, over everything only if
they are empty. Nothing is thrown away, so the reach of matching is back.

The defect itself — pinning a question to one meaningless word — is removed at
the other end: a winning LONE WORD is widened to the sentence containing it,
clipped to its own block and capped at 200 characters (a run-on falls back to a
bounded word-snapped window). A phrase match is never widened. `Anchor` gained
a `match: {start, end}` field carrying the span the question's words actually
matched, so the matching rules stay observable — and so a consumer can mark the
matched word inside the highlighted sentence.

Measured with `.bughunt/probe-s27.ts`, 4000 fiction draws against
`SAMPLE_DRAFT`:

| | pre-hunt | f37a156 | now |
|---|---|---|---|
| anchored draws | 2390 / 4000 | 690 / 4000 | **2394 / 4000** |
| single-word share of anchors | 98.5 % | 94.1 % | **0 %** |
| fragments <= 5 chars | 84.6 % | 45.2 % | **0 %** |
| median fragment chars | 4 | 6 | 102 |

Both halves of R1's stated acceptance test hold: the anchored-draw rate did not
fall, and the single-word share did. Regressions in `web/anchor.test.ts`
(`anchor widening (R1)`) cover the block boundary, the length cap, phrase
matches staying unwidened, and quality preference.

## ~~R2 — The `-ly` exclusion table covers the probe's words, not the class~~

**Fixed** — `web/window-stats.ts`. `NON_ADVERB_LY` went from 26 words to ~140,
sized to the closed classes rather than to a probe string. The docstring now
states WHY a table is the right instrument here, which was the missing
justification: `-ly` adverbs are an open, productive class, while `-ly`
adjectives are CLOSED and `-ly` nouns and verbs are finite. The excludable set
is enumerable and the keepable set is not — which is the right way round.

Words that are commonly both adjective and manner adverb ("kindly") are
deliberately absent, so their adverbial use still counts.

Measured (`.bughunt/t1.ts`), on prose the fix was not written from:

```
adjectives in -ly (fiction)   adverbRate 40.0 -> 0.0   hedge axis: fired -> silent
nouns in -ly                  adverbRate 33.3 -> 0.0   hedge axis: fired -> silent
verbs in -ly                  adverbRate 27.3 -> 0.0   hedge axis: silent
genuine adverbs               adverbRate 33.3 -> 33.3  hedge axis: fires
```

## ~~R3 — The stative `-ed` table covers the probe's words, not the class~~

**Fixed** — `web/window-stats.ts`. `STATIVE_ED` is DELETED rather than grown.
It could not work: unlike `-ly` adjectives, predicate participles are an open
class — almost any transitive verb's participle stands predicatively — so no
list can separate "was broken (by the storm)" from "was determined".

The proxy is now high-precision and low-recall by design. A bare `was/were` +
`-ed` counts for nothing; only an explicit passive marker does:

- an agent phrase — `was broken BY the storm`, allowing up to two intervening
  words so "was quietly removed by …" still reads,
- the progressive passive — `was BEING repaired`, which has no adjectival
  reading at all.

The participle may end `-ed` or `-en`, so the large irregular class (broken,
taken, written, chosen) survives; a 10-word `NOT_A_PARTICIPLE` guard stops
ordinary words with those endings from matching before an agent `by` ("he was
often by the window"). That guard is a check on a positional pattern, not an
attempt to enumerate participles.

The cost is stated in the code: `The letters were burned.` is a genuine
agentless passive and is not counted. That is the right trade — the passive
credit is a bonus on top of `nominalRate`'s primary suffix count, and a bonus
that fires on the wrong sentences is worse than one that fires on fewer.

Measured (`.bughunt/t1.ts`):

```
stative -ed not in the old table   nominalRate 33.3 -> 0.0
adjectival -ed                     nominalRate 25.0 -> 0.0
passive with an agent              nominalRate  9.1 -> 9.1   (still counts)
```

## ~~R4 — `isGrounded`'s prefix rule trades one wrong answer for two~~

**Fixed** — `src/gate.ts`. The prefix rule is replaced by STEM comparison. A
new `stem()` strips one inflectional suffix (`ing`, `ied`/`ies`→`y`, `ed`,
`es`, `s`), drops a silent trailing `e`, folds trailing `y` to `i`, and undoes
a doubled final consonant. Both sides are stemmed and compared for equality.

This fixes both directions at once. Coincidental front-overlap is gone
(moth/mother, room/roommate, fall/fallout, light/lightning), and inflections
that change a letter now ground where the prefix rule dropped them
(carry/carried, story/stories, stop/stopped, store/stored, run/running).
Irregulars (run/ran, knife/knives) stay unmatched, and the docstring says so
instead of claiming the rule "keeps genuine stem matches".

R4 also demanded the recall number that the prefix fix never took. Measured
with `.bughunt/t3-grounding.ts` — all 1757 seed-bank questions against the
real sweep windows of `SAMPLE_DRAFT`, 3514 pairs:

```
grounded, prefix rule (f37a156): 1150 = 32.7%
grounded, stem rule    (R4 fix): 1187 = 33.8%
  lost by the stem rule: 181 = 5.2%   (the prefix accidents)
  won by the stem rule:  218 = 6.2%   (real inflections)
```

Grounding got slightly MORE permissive while getting more correct, so the
tightening does not raise the gate's fallback rate. The compound case the old
tests asserted (`storekeeper` grounding against `store`) is now false by
contract, and the test says why.


---

# Waves three-five — first pass (2026-08-24)

A parallel hunt added 30 more findings (H1-1..H9-3) at the post-R1-R4 tree.
Three of them land on code changed in this session, so they were verified and
fixed first. The rest are open in [BUGS.md](BUGS.md).

Each was independently reproduced before being fixed (`.bughunt/v-a.ts`,
`v-a2.ts`) — the previous round found 5 of 61 claimed resolutions did not
hold, so a reported finding is treated as a hypothesis until it runs.

Suite: 29 files / 490 tests green; `tsc --noEmit` clean. R1-R4's measurements
re-run unchanged (anchored 2394/4000, single-word 0%, grounding 33.8%, all
three S1-0 gate attacks still blocked).

## ~~H3-1 — U+0130 case-folding shifts anchor offsets past the token~~

**Fixed** — `web/anchor.ts`. Offsets were computed as `token.start + index`,
where `index` was an index into the LOWERCASED token. Lowercasing is not
length-preserving (Turkish `İ` folds to two code units), so every offset after
such a character was wrong.

`Token` now carries an `offsets: number[]` map built during tokenization: one
draft offset per character of the lowered form, plus an end sentinel. A fold
that expands maps every character it produced to the start of the code point
that produced it. Every offset derived from a comparison index goes through
the map; nothing adds an index to a raw start any more.

Verified: `İtyped` in `aaa bbb İtyped ccc` matched `[10,15) "yped "` before —
wrong start AND a leaked space — and matches `[9,14) "typed"` now.

While routing offsets through the map I inverted first-hunt #14's rule (a
fragment must never end mid-word) and its two regression tests caught it
immediately. The end is now unconditionally the containing token's boundary,
which is what both branches of the old expression already computed.

## ~~H1-4 — Names ending in -ly fire the hedge axis~~

**Fixed** — `web/window-stats.ts`. This was a real hole in R2's reasoning: R2
argued a table is the right instrument because `-ly` adjectives are a CLOSED
class, but proper nouns ending in `-ly` (Emily, Kelly, Beverly, Sicily) are an
open class, and no list closes it. All eight names tested scored adverbRate
10.0 and fired the `hedge` axis.

Handled structurally instead, by capitalization — the only evidence available
without a lexicon. A capitalized `-ly` word is a proper noun, decisively so
mid-sentence. At a sentence start, where an adverb is capitalized too, the two
are separated by what FOLLOWS: an adverb is followed by a comma or by the
subject ("Slowly, he turned" / "Suddenly the door opened"), while a name IS
the subject and is followed by its verb ("Emily left the room").

Measured, on cases from both directions:

```
names, sentence-initial and mid-sentence   adverbRate 10.0 -> 0.0, axis silent
adverbs opening a sentence                 still counted (16.7 - 25.0)
adverbs mid-sentence                        still counted, unchanged
```

## ~~H1-6 — Frequency -ly adverbs excluded against the table's own docstring~~

**Fixed (docstring)** — `web/window-stats.ts`. A fair catch on writing I did
in R2: the comment claimed dual adjective/adverb words are kept as a rule
(citing "kindly"), while early/daily/weekly/monthly/nightly/hourly/quarterly/
yearly sat in the table and are dual too.

The behaviour was right and the stated reason was wrong. The axis targets
MANNER adverbs — the ones that dilute a verb, which is the craft note it
steers toward. Frequency and time words modify *when*, not *how*, so they are
outside what the axis measures; "kindly" is a manner adverb and still counts.
The docstring now says that, and a test pins both halves.


<!-- original finding text, as recorded by the wave-three hunt -->

## H1-4 — Names ending in -ly fire the hedge axis

```
Emily/Kelly/Wally/Sicily/Tully/Shelly "<name> left the room..." adverbRate 11.1 axes [hedge]
control without a name                                          adverbRate 0    axes []
```

Repro: `.bughunt/h1-probe2.ts`. R2's design ("enumerate the closed classes")
cannot cover proper nouns — an open class. Note the fix state at recording
time: Bailey and Riley pass, the other six names fail; the exclusion set was
again grown by exactly the tested words. No fixed table fixes this class.

**Solid:** as R2's own alternative suggested, count a -ly word as an adverb
only when it directly precedes or follows a verb. A name before "left" would
then pass on structure alone.

## H1-6 — Frequency -ly adverbs excluded against the table's own docstring

The `NON_ADVERB_LY` comment says dual adjective/adverb manner words are
deliberately kept so their adverbial use counts (citing kindly/fully/wholly).
But early/daily/weekly/monthly/yearly/nightly/hourly/quarterly — also dual —
are listed, so `"She arrives early. He trains daily..."` scores adverbRate
0.00 while `"He kindly agreed."` scores 33.3. Internal inconsistency with the
documented contract, not a coverage gap. Repro: `.bughunt/h1-probe2.ts`.

## H3-1 — U+0130 case-folding shifts anchor offsets past the token, sometimes past the document

`findCandidates` computes offsets on the LOWER-CASED token; `İ`
toLowerCase()s to two code units, so lengths shift by one:

```
initial-İ:   match=[15,24) slice="İstanbul "            match leaks whitespace
İ-at-doc-end: match=[6,15) ANCHOR OUT OF DOC (end > draft.length)
İ-prefix-in-token "İtyped": match=[6,11) slice="yped "  wrong start AND leak
```

Repro: `.bughunt/h3-anchor-final.ts`; randomized sweep (60 docs × emoji/
accents/CRLF) hits whenever İ sits in/before a matched word. `match` is a
test-encoded contract ("trailing punctuation/whitespace never enters the
match"); notes.ts persists the unclamped anchor verbatim. Consumers clamp,
so nothing crashes — the marking and the stored span are just wrong.

**Solid:** compute offsets on the RAW token, lowercase only for comparison
(compare lowered candidate vs lowered needle, index into the raw string).


---

# Waves three-five — the rest (2026-08-24)

29 of the 30 wave-three-to-five findings are fixed and measured. The one left
open is H5-3, an editorial pass over 194 non-verbatim source quotes, which is
described at its true scale in [BUGS.md](BUGS.md) rather than partly done.

Every finding was independently reproduced before being fixed — the earlier
round found 5 of 61 claimed resolutions did not hold, so a reported finding is
a hypothesis until it runs. Probes: `.bughunt/v-a.ts`, `v-a2.ts`, `v-b.ts`,
`v-b2.ts`, `v-c.ts`, `v-c2.ts`, `v-d.ts`, `v-e.mjs`, `v-h91.ts`, `v-h92.ts`,
`v-h93.ts`, `h5-quotes-full.py`.

Suite: 531 TS tests / 30 files, 39 Python tests, `tsc --noEmit` clean. R1-R4's
measurements re-run unchanged.

## Heuristics — window-stats and cadence

- **~~H1-1~~ filter verbs** — `FILTER_VERBS` held six past-tense forms, making
  the axis a tense detector: identical prose scored 40.0 in past tense and 0.0
  in present or continuous, so present-tense narration got no steering. The
  contract fixes the six VERBS, so their inflections are a closed set and are
  now enumerated exactly (including British `-ise`). All three tenses fire.
- **~~H1-2~~ sentence splitter** — split after any `.` before whitespace, so
  `Mr.`/`Dr.`/`St.` and `...` manufactured sentences and skewed every
  sentence-shape statistic ~3x in fiction. Now a scanner that skips known
  abbreviation dots and never splits inside an ellipsis; `etc` and `no` are
  deliberately NOT exempt, since both routinely do end a sentence. Title-laden
  prose: mean 1.50 -> 3.00 (the true four sentences).
- **~~H1-3~~ nominalizations** — `/(?:tion|ment|…)$/` is a SPELLING test, so
  "moment" alone crossed the 5% threshold. Two guards: a closed
  `NOT_A_NOMINALIZATION` table for words whose ending is not a suffix, and a
  noun-position test that separates "the mention of it" from "they mention
  it". Measured 44.4 -> 0.0 on the false-positive line, 33.3 unchanged on real
  nominalizations.
- **~~H1-5~~ cadence word count** — counted raw whitespace tokens, so `##`,
  `**`, bullets and `---` were words and a structure-only document tripped the
  30-word auto-ask threshold, firing a question on no new prose. `window-stats`
  now exports `countProseWords` and cadence uses it, so the two modules answer
  "what is a word?" the same way by construction.
- **~~H1-7~~ wrapped dialogue** — `QUOTE_SPAN_RE` forbade `\n`, so hard-wrapped
  speech scored 0.000 where the identical unwrapped line scored 0.714. Soft
  breaks are allowed now; a BLANK line still ends the span, so an unclosed
  quote cannot swallow the window.

## Gate, probes, and the seed draw

- **~~H2-1~~ gate false negatives** — a rejected output is not free: it spends
  the retry and hands back a fixed topic probe. `Is Dr. Smith coming?`,
  `Why does 3.5 matter here?`, `Does the text use e.g. or i.e.?` and `Why?!`
  all failed. Now a `.` inside an abbreviation, a decimal, or a word is not a
  terminal, and the output ends in a terminal CLUSTER of `?`/`!` containing at
  least one `?`. Two-sentence outputs and the three S1-0 attack shapes are
  still blocked; `Really!!` still fails.
- **~~H2-2~~ ASCII-only tokenizer** — `/[^a-z0-9]+/` treats every non-ASCII
  character as a DELIMITER, so "café" became "caf" and "déjà" vanished
  entirely. Both predicates built to catch the model restating the passage were
  blind to any accented word — the exact output an accent-normalizing model
  produces. All predicates now fold through NFKD with combining marks removed
  and tokenize on `\p{L}`/`\p{N}`.
- **~~H2-3~~ seed draw (user decision: genre-specific always favoured)** — the
  old rule set the probability of the PILE (`min(0.5, matched/16)`), so the
  per-seed rate was `0.5/matched` and moved with pile size instead of intent:
  fiction's 898 specific seeds were 0.64x as likely PER SEED as the 563
  agnostic ones — backwards — while poetry's 8 specific seeds took ~51% of all
  draws. Replaced by a per-seed weight: `p = w*m / (w*m + c)`, `w = 3`. Measured
  per-seed ratio is exactly 3.00 at every pile shape tested (898/563, 497/580,
  8/580), and poetry's 8 seeds now take 3.9%. Changed in BOTH implementations
  in lockstep, with the golden drawer vectors regenerated — cross-language
  parity still asserts exact sequence equality.
- **~~H2-4~~ imperative fallback probe** — `TOPIC_PROBES[5]` ended in '.' and
  failed the app's own gate, so on every fallback where
  `textWindow.length % 6 === 5` the writer got a directive from the one path
  guaranteed to run. Rewritten as a question, and a new `src/topic-probe.test.ts`
  asserts EVERY probe passes `isSingleQuestion` — so no directive can hide in
  one again.

## Save, editor, BYOK, STT

- **~~H3-2~~ post-unmount save** — `dispose()` cleared timers, but a save already
  in flight re-armed a debounce from its finally block as it settled, so a newer
  payload persisted strictly after unmount — into a mode-switched store, since
  `getStore()` is read at fire time. A `disposed` latch now guards the single
  choke point that arms a save. Writing the test caught a second hole: `edit()`
  after `dispose()` still saved. Disposal is final now, and says so.
- **~~H6-1~~ auto-ask double-fire** — `cadence.observe()` never self-resets and
  the only re-arm runs AFTER the await, so every poll during a slow ask fired a
  second concurrent ask — normal operation whenever the model is slower than the
  poll. An in-flight latch holds for the whole ask.
- **~~H6-2~~ re-entrant sweep** — the guard read React state while the durable
  latch was `sweepingRef`, so two clicks before the commit both entered and
  every window was asked twice (billed twice in byok). Gated on the ref.
- **~~H6-3~~ stale notes on an empty load** — an early return on
  `annotations.length === 0` skipped the reset, so switching to a store with no
  notes left the previous store's notes on screen and the next save wrote them
  into the new store. Empty lists are adopted too.
- **~~H7-1~~ padded BYOK configs** — sanitize blessed a baseUrl with a trailing
  space, which assembles `/v1%20/chat/completions`, a guaranteed 404. All three
  string fields are trimmed before validation; a whitespace-only `sttModel` is
  absent rather than truthy.
- **~~H7-2~~ TRANSCRIBES_AUDIO unenforced** — the guard read `sttModelFor` only,
  so a stale override defeated it: the provider switch preserves `sttModel`, so
  openai -> openrouter left `whisper-1` behind and the writer's API key was
  POSTed to a route that 404s. The contract is checked before the network call.
- **~~H7-3~~ raw provider bodies** — a 502 HTML page landed whole in a toast, and
  a 200 with a non-JSON body escaped as `SyntaxError: Unexpected token <`. One
  bounded `errorDetail` (markup stripped, 200 chars) and a `readJson` that names
  the provider instead.
- **~~H8-1~~ openStream had no deadline** — `transcribe()` has had one since
  S3-10; `openStream()` awaited stream-ready forever against a live-but-stuck
  worker, settling only on dispose(). Same treatment: a 30s deadline, reject,
  tear the worker down so the next call spawns fresh.

## Server

- **~~H4-1~~ malformed Host crashed before the boundary** — `handle()` builds a
  URL from the UNTRUSTED Host before Hono runs, so `[::1]evil.com`,
  `127.0.0.1:evil` and `::1` all threw inside the adapter and surfaced as a
  generic 500: the documented fail-closed 403 was unreachable for exactly the
  inputs it exists to reject. Host is now validated against `SAFE_HOST_RE`
  first. Underneath, `hostWithoutPort` returned everything up to `]` regardless
  of what followed, so `[::1]evil.com` normalized to loopback and would have
  been ACCEPTED had the parse not crashed — anything after `]` that is not
  `:digits` now fails closed. Verified over raw sockets: all five malformed
  hosts return 403, the valid control still returns 200.
- **~~H4-2~~ no body cap** — a 50 MB `/save` was accepted, buffered and written
  to disk. Capped at 5 MB on BOTH the declared Content-Length and the received
  byte count (a chunked request declares nothing), answering 413 before
  destroying the socket so a client learns why. Verified live: a 6 MB POST
  returns `413 {"error":"request body too large"}` and nothing reaches disk.
- **~~H4-3~~ /ask leaked internals** — returned `err.message` verbatim, exposing
  retrieve.py stderr and filesystem paths, while `/transcribe` deliberately
  returned generic errors. One `internalError` helper: the console keeps the
  detail, the writer gets a sentence.

## Sweep and draft IO

- **~~H9-1~~ duplicate fragments remapped to the wrong occurrence** — the remap
  measured distance from the STALE ABSOLUTE start, so any insertion before both
  occurrences made the EARLIER duplicate "nearest" and the writer's pinned
  highlight jumped to a different identical sentence. Distance cannot fix this:
  a pure insertion shifts every occurrence equally. Notes now carry an optional
  `context` (32 chars either side, captured at mint time), which survives the
  shift and decides when available; a tie or a legacy note without context
  falls back to distance. Measured: both failing edits from the finding now
  remap correctly WITH context and still wrong without it.
- **~~H9-2~~ thematic breaks as the marked block** — `splitBlocks` keeps `---` as
  a first-class paragraph, so a window's marked block could be
  `[CURSOR START]\n---\n[CURSOR END]`, or a whole window could be just `---`. A
  window with no quotable words fails `isGrounded`, spends the retry and falls
  back — a wasted token in byok. Breaks are filtered from the plan, using
  `text-window`'s own exported `THEMATIC_BREAK_RE` rather than a second copy.
- **~~H9-3~~ unsynchronized draft IO** — the server's `ioSerial` wraps the
  routes, but the seam is exported and used directly by tests and any non-server
  caller, where a load racing a save observed torn or stale content. The seam
  serializes its own operations now, and writes through a temp file + rename so
  a reader sees the old file or the new one, never half — with an in-place
  fallback (and a warning) where the directory refuses a temp file, because a
  save that lands beats a save that does not. Measured: 400 concurrent 8 MB
  read/write pairs, zero torn or empty reads.

## Seed bank

- **~~H5-1~~ schema.json was a spec nothing enforced** — `_validate` checked key
  presence only, so an unknown verb, an unknown genre, or an empty question all
  stored cleanly; an unknown-genre seed is permanently unreachable by every
  genre query and nothing flagged it. `_validate` now enforces the declared
  enums and non-empty floors. The whole live bank passes, so this is a gate on
  new seeds, not a retroactive break.
- **~~H5-2~~ duplicate ids silently clobbered a seed** — two extraction files
  carried the same id with DIFFERENT questions; the upsert kept whichever landed
  last and `len(rows)` reported success either way. `insert_seeds` now refuses a
  duplicate within a batch and returns `(inserted, replaced)`, and the CLI warns
  on any replacement. The two colliding ids were real distinct seeds, so the
  chapter-12-15 variants were renamed and re-imported: **the bank went 1757 ->
  1759, recovering two seeds that had been lost.**
- **~~H5-4~~ the seeds/ directory contract was implicit** — `seeds/*.json` is not
  uniformly a seed artifact, so a naive glob reported 1638 "duplicate ids":
  every id in the bank, once from its chapter file and once from `client.json`,
  the generated export of those very files. `NON_EXTRACTION_FILES` and
  `extraction_files()` make the three kinds of file explicit — with the contract
  stated, the duplicate check found exactly the 2 real collisions above.


<!-- original finding text, as recorded by the wave hunts -->

## H1-1 — Filter verbs: only six past-tense forms exist (web/window-stats.ts)

`FILTER_VERBS` is an exact-match set of single inflected forms (felt, seemed,
noticed, realized, watched, wondered). Every other inflection escapes:

```
present   (seems/feels/watches/wonders/notices/realizes) -> filterRate 0.00 axes []
past      (same six, -ed forms)                          -> filterRate 27.27 axes ['filter-word']
-ing      (feeling/watching/noticing/wondering/realizing) -> filterRate 0.00 axes []
```

Repro: `.bughunt/h1-probe.ts`. Two windows with identical content score 0 %
vs 27 % purely on tense — the R2/R3 probe-shape again. Because a fired axis
drives `implVerbs()` → `--lean-verbs` → the seed draw, present/continuous
narration saturated with interiority gets no steering at all.

**Solid:** match the verb stem and accept its inflections, not six literals.

## H1-2 — Sentence splitter treats every pre-whitespace period as terminal

`splitSentences` (`/(?<=[.!?][”'\"']*)(?:\s+|$)/`) breaks after any `.!?`
followed by whitespace. Abbreviations and ellipses inject spurious sentences:

```
"Mr. Darcy wrote. Mrs. Smith read. Dr. Lee slept. St. John waited."
  4 real sentences -> sentenceMean 1.5 sigma 0.5 (8 measured)
same text without the title periods                              -> mean 3.0 sigma 0
"He walked down the hall... then paused. She waited."            -> mean 3.0 (3 sentences)
without the ellipsis                                             -> mean 4.5 (2 sentences)
```

Repro: `.bughunt/h1-probe2.ts`. Titles like Mr./Dr./St. are ubiquitous in
fiction; the rhythm-axis stats are wrong by ~3x there.

**Solid:** skip known abbreviation dots (a short list is defensible because
the class is closed) and never split inside `...`.

## H1-3 — Nominalization suffix test has no part-of-speech check

`NOMINAL_SUFFIX_RE = /(?:tion|ment|ance|ence|ity|ness)$/i` matches any word
with those endings:

```
"She paused for a moment before answering the question."  nominalRate 22.22 axes ['nominal']
"They mention the witness and comment on the garment."    nominalRate 44.44 axes ['nominal']
```

Repro: `.bughunt/h1-probe.ts`. Zero actual nominalizations in either line;
"moment" alone crosses the 5 % threshold in a short window. Distinct from R3
(the stative `-ed` table): this suffix counter needs no passive voice to be
wrong.

**Solid:** count a suffix word as a nominalization only when a light verb
(`make/take/give/reach + the N-of`) or a derivational pair with a nearby verb
supports it; otherwise measure the false-positive rate on a real corpus.

## H1-5 — Markdown scaffolding trips the auto-ask threshold (web/cadence.ts)

`words()` = raw whitespace-token count, so `##`, `**`, `` ` `` , `-` bullets
and `---` all count as words:

```
structure-only doc (headings, 11 bullets, code fence, ---):
  real prose words = 23, raw tokens = 61
observe(doc, 0)     -> armed
observe(doc, 30_000)-> ready   // fires a coaching question on no new prose
```

Repro: `.bughunt/h1-probe2.ts`. window-stats deliberately strips these same
tokens when measuring (`stripMarkdown`), so the two modules disagree about
what a word is; the interruption gate is tripped by scaffolding.

**Solid:** cadence should count words the same way window-stats does.

## H1-7 — Dialogue wrapped across a newline does not count

`QUOTE_SPAN_RE` forbids `\n` inside the span, so hard-wrapped speech scores
0 where the identical unwrapped speech scores 71 % dialogue density:

```
'"I cannot believe\nyou did that," she said.' -> dialogueDensity 0.000 axes []
'"I cannot believe you did that," she said.'  -> dialogueDensity 0.714 axes ['dialogue']
```

Repro: `.bughunt/h1-probe.ts`. Low impact under the app's one-paragraph-per-
line convention; higher if drafts ever wrap.

## H2-1 — isSingleQuestion's false negatives: abbreviations, decimals, "?!"

A period inside Dr./Mr./Mrs./St./e.g./i.e./a decimal reads as a sentence
terminal, and a final `?` after `!` fails the last-char rule:

```
FAIL  "Is Dr. Smith coming?"        FAIL  "Why does 3.5 matter here?"
FAIL  "Did you see Mr. and Mrs. Jones?"   FAIL  "Where is St. Paul's cathedral?"
FAIL  "Does the text use e.g. or i.e.?"   FAIL  "Why?!" / "How dare you?!"
PASS  multi-question controls correctly rejected ("Did you ask her? Or did she?")
```

Repro: `.bughunt/h2-gate.ts`, `h2-confirm.ts`. Each rejected string is ONE
genuine question; failing the gate spends the single retry and hands back a
fixed topic probe. This is R4's shape (recall lost to a syntax predicate) but
on `isSingleQuestion` — R6 covered only its advice pass-through.

**Solid:** whitelist dot-followed-by-lowercase/digit continuations plus a
closed abbreviation set; treat `?!` as one terminal. Then measure fallback
rate before/after with scripts/k-sweep.ts, as R4 prescribed.

## H2-2 — Non-ASCII characters are delimiters: copiesSeed/echoesText miss

`contentWords`/`wordBigrams` split on `/[^a-z0-9]+/`:

```
"café" -> ["caf"]   "déjà" -> [] (both fragments <3 chars: word vanishes)
"fiancée" -> ["fianc"]
echoesText("The cafe is loud?", "The café is loud.")  false  // same echo, missed
copiesSeed(seed "café in the plaza", q "cafe in the plaza") false  // near-copy escapes
```

Repro: `.bughunt/h2-confirm.ts`. Accent-normalizing models routinely produce
exactly the second form; both predicates built to catch restatement are blind
to it. Same lossy-tokenization class as R4.

**Solid:** tokenize on Unicode letter/number classes (`/\p{L}|\p{N}/u`) and
NFKD-strip diacritics before comparison.

## H2-3 — Pile-level genre preference distorts per-seed rates both directions

`pickSeed`: `effectiveP = Math.min(0.5, specific.length/16)` then uniform
inside each pile. Per-seed rate is therefore 0.5/pile size — measured over
20 000 draws per genre (`.bughunt/h2-pickseed-groups.ts`):

```
fiction  specific=898 agn=563   per-seed ratio 0.64  (PREFERS AGNOSTIC — inverted)
memoir   497/580    1.20        essay 236/580   2.54
poetry   specific=8  agn=580    per-seed ratio 75.02  (8 seeds ≈ 51 % of all draws)
```

For poetry the genre effectively draws from eight recurring seeds, defeating
a 588-seed pool; for fiction the intended specific-preference per seed runs
backwards. `seeds/retrieve.py default_genre_preference` shares the formula
(the parity test pins sequence equality), so the defect is server-side too.

**Solid:** make per-seed probability equal across the whole filtered pool
(specific flag as tie-breaker only), or scale effectiveP ∝ pile sizes
without the 0.5 cap — and say which behavior is intended, because intent
cannot be inferred from the current numbers.

## H2-4 — Fallback probe [5] is an imperative, not a question

`TOPIC_PROBES[5]` = "Say in one plain sentence what this passage is really
about." — ends in '.', fails the app's own `isSingleQuestion`. On every
fallback where `textWindow.length % 6 === 5` the writer receives a directive.
The guaranteed-to-run path violates the one-question contract the README
sells (R6). Repro: `.bughunt/h2-gate.ts`.

## H3-2 — dispose() leaks a post-unmount save via the finally re-arm

Ordering: save in flight + newer pending payload + dispose() before the
in-flight save settles. `trySave`/`flush`'s finally block re-arms a debounce
timer after dispose cleared all timers:

```
timers after dispose         : 0
timers after in-flight done  : 1   (finally re-armed)
saves received               : ["A","B"]   // "B" persisted strictly after unmount
```

Repro: `.bughunt/h3-savecoord-dispose.ts`. Violates dispose()'s own docstring
and the module's "can never double-send" claim; getStore() evaluated at fire
time means the ghost save can even target a mode-switched store.

**Solid:** add a `disposed` flag checked by the finally re-arm.

## H4-1 — Malformed Host crashes before the boundary runs; bracket-suffix acceptance is latent

Raw-socket probes (fetch silently overrides Host, sockets do not): Host
values `[::1]evil.com`, `[::1]:evil`, `127.0.0.1:evil`, `127.0.0.1:999999`,
`::1` all yield **500 {"error":"internal server error"}** — `handle()` builds
a URL from the untrusted Host *before* `app.fetch()` runs boundaryViolation,
so the documented fail-closed 403 is unreachable for malformed hosts and the
uncaught exception is the first gate. Underneath, `hostWithoutPort` returns
everything up to `]` regardless of what follows, so `[::1]evil.com` would
normalize to loopback and be accepted if the parse did not crash first.
Verified against an isolated instance (BW_PORT=4771, /tmp copy); 4517 and the
repo's data/ untouched. Repro: `.bughunt/h4-boundary.mjs`, log excerpt in
`.bughunt/h4-FINDINGS.md`.

**Solid:** validate/sanitize Host in middleware that runs before URL
construction, or parse defensively in handle(); reject anything after `]`
that is not `:`digits.

## H4-2 — No request-body cap on /save, /ask, /transcribe

POST /save with a 50 MB draft → 200 `{}`; `data/drafts/current.md` becomes
52,428,800 bytes. Fully buffered (`c.req.text()`); two concurrent large saves
double the memory. The boundary's premise is that local processes are hostile
to /save; memory+disk exhaustion via one request is open. JSON nesting itself
is handled well (5M-deep arrays → clean 400). Repro: `.bughunt/h4-payload.mjs`.

**Solid:** enforce Content-Length and streamed-byte caps (e.g. 5 MB draft,
tighter for annotations) with 413.

## H4-3 — /ask leaks internal error text; /transcribe does not

With the seed bank moved aside, /ask returned 500 `{"error":"seed pull failed
for genre \"fiction\": seed pull returned no seeds (empty array)"}` — err.message
verbatim, exposing internals incl. retrieve.py stderr paths. The provider-
failure path is graceful (200 topic-probe fallback, nothing leaked), and
/transcribe deliberately returns generic 503s: the two protected endpoints
disagree about disclosure, and the coach endpoint is the leaking one.
Repro: `.bughunt/h4-final.mjs`.

## H5-1 — schema.json is a spec, not a gate: unknown verb/genre and empty question store cleanly

`retrieve._validate` checks key presence and non-empty genres only. On a COPY
of the bank (.bughunt/h5-tmp.db), real bank hashes byte-identical before and
after:

```
unknown-verb 'teleport'  -> accepted, landed=True
unknown-genre 'horror'   -> accepted, landed=True   (permanently unreachable by genre queries)
empty-question           -> accepted, landed=True   (would be fed to the model)
missing-quote            -> ValueError raised cleanly (the one enforced field)
```

Repro: `.bughunt/h5-validate.py`. An unknown-genre seed becomes dead weight
for the query axis forever; nothing flags it.

**Solid:** load schema.json's enums/minLength in _validate, and have export
re-validate every row against it.

## H5-2 — Duplicate ids across extraction files silently clobbered a distinct seed

`alberts-intro-ch01-purpose.json` and `alberts-ch12-15-pace-balance.json`
both carry id `alberts-voice-in-summary` (likewise `alberts-scene-purpose-
check`) with DIFFERENT questions/chapters. The upsert (`ON CONFLICT(id) DO
UPDATE`) kept only the intro variant; the ch12-15 variant is gone from the
bank, and `insert_seeds` reports len(input) either way — the loss leaves no
signal. Repro: `.bughunt/h5-schema.py`.

**Solid:** detect duplicate ids across seeds/*.json at validation time, and
surface rows-replaced from insert_seeds.

## H5-4 — vocab.json breaks the "every seeds/*.json is a seed artifact" assumption

`seeds/vocab.json` is constants ({genres, verbs, _notes}); any glob-based
seed validator false-positives on it, and the directory contract is implicit.
Also recorded during the audit: 71 bank ids (sweep children, `-b`/`-c`/-d`)
exist in no chapter/staging file — expected post-sweep drift, worth one line
in docs, not a store bug. Repro: `.bughunt/h5-schema.py`.

---

## H6-1 — Auto-ask double-fires while a previous ask is in flight (S2)

`cadence.observe()` never self-resets after `ready`; the only re-arm is
`cadence.reset(base)` in askCursorWindow's `finally`, which runs AFTER the
await. Every 5 s poll during a slow ask therefore observes `ready` again:

```
.bughunt/h6-cadence-doublefire.ts:
asks fired by t=40s: 2 (t=25s, 30s)   max concurrent asks in flight = 2
EXPECTED 1 / max 1  -> DOUBLE-FIRE CONFIRMED
```

Fires in normal operation whenever the model answers slower than the poll.
Fix at fire time: reset cadence before the await, and/or guard
askCursorWindow against re-entry. (Related verified non-bug: the error path
does NOT latch — catch is empty by design and finally always re-arms,
`.bughunt/h6-error-path.ts`.)

## H6-2 — Sweep button is re-entrant on double-click (S3)

The guard reads React state (`if (!coach || sweeping) return`) while the
durable latch is `sweepingRef`. Two clicks land before React commits state;
both enter:

```
.bughunt/h6-sweep-reentry.ts: planSweep = 3 windows; coach.ask invoked 6 times (expected 3)
```

Duplicate asks for every window; duplicate notes survive dedupe (timestamps
differ). Fix: gate on `sweepingRef.current`.

## H6-3 — Loading a store with zero annotations keeps stale notes (S3, latent)

`loadDraftAndNotes`:270 early-returns on `annotations.length === 0`, skipping
the annotationsRef/sweepNotes reset:

```
.bughunt/h6-mode-switch-empty.ts: source 2 notes -> destination empty store;
on screen after load: 2 stale notes; next save persisted 1 into the NEW store
```

Not reachable through today's UI (static and byok share localStorage keys),
hence latent — but the fix is one line: adopt even empty lists when the
sequence is current.

## H7-1 — Whitespace-padded BYOK configs are blessed by sanitize (S3)

```
.bughunt/h7-fuzz.ts: baseUrl "https://api.openai.com/v1 " -> LOADS with space kept
  assembled request URL pathname becomes "/v1%20/chat/completions" (guaranteed 404)
apiKey "sk-abc " -> LOADS; sttModel "   " -> LOADS as truthy
slash duplication IS stripped correctly; null/non-string fields rejected correctly
```

The in-app form trims before save, so this needs hand-crafted or hostile
localStorage — but then loadByokConfig certifies a config that can never
work instead of falling back to setup. Fix: trim the three string fields in
sanitize.

## H7-2 — TRANSCRIBES_AUDIO is documentation, not enforcement (S2)

transcribeWavByok guards only on `sttModelFor()`, never on TRANSCRIBES_AUDIO:

```
.bughunt/h7-request.ts probe I: provider=openrouter + explicit sttModel='whisper-1'
  -> real POST to https://openrouter.ai/api/v1/audio/transcriptions, resolves (no throw)
```

Reachable without touching localStorage: EditorApp's provider switch preserves
the sttModel field, so openai->openrouter leaves whisper-1 behind and the
stale value defeats the guard — the API key goes out to a route that will
404. Fix: check TRANSCRIBES_AUDIO pre-network.

## H7-3 — Provider error bodies pasted verbatim into user-facing errors (S3)

Non-ok responses paste res body text into the thrown message with no cap
(a 502 HTML proxy page lands whole in the toast); an ok response with a
non-JSON body escapes as raw `SyntaxError: Unexpected token <`. Same shape
in transcribeWav via dictation.ts. `.bughunt/h7-request.ts` section C/E,
`.bughunt/h7-dictation.ts` B.

## H8-1 — openStream() hangs forever against a live-but-stuck worker (S3)

`transcribe()` arms TRANSCRIBE_TIMEOUT_MS=120s + SIGKILL (the S3-10 fix);
`openStream()` awaits ready.promise with no deadline at all. Same
ensureSpawned worker that never answers stream-ready → STILL PENDING after
3 s and beyond; only dispose() settles it (`.bughunt/h8-openstream-timeout.ts`).

## H9-1 — Duplicate fragments: the pinned highlight jumps to the wrong occurrence

`staleAnnotations` measures distance from the stale ABSOLUTE start, so after
any insertion before both occurrences of a fragment, the EARLIER duplicate is
"nearest" and wins:

```
.bughunt/h9-multi.ts: 'echo' at 19 and 44, annotation on SECOND.
insert 40 chars between them -> remapped to start=19 (FIRST/WRONG);
insert 40 chars BEFORE both   -> also flips to FIRST (wrong).
trigger: any insert k>=13 chars before both occurrences.
```

The existing test hides this by drifting the reference 3 chars PAST the
occurrence — an offset no real edit produces. Net effect: the user's pinned
highlight moves to a different identical sentence. Fix candidates: prefer the
occurrence that preserves relative position to neighbors, or re-ground on
surrounding context words instead of raw distance.

## H9-2 — Thematic-break lines become the window's marked block

splitBlocks treats `---` as a first-class paragraph; partitionSections starts
a section at it; planSweep then groups it with the next paragraph or leaves
it alone:

```
.bughunt/h9-plan.ts: break-heavy doc -> 3 windows whose markedText wraps '---':
  "[CURSOR START]\n---\n[CURSOR END]\n\nPara two."
lone trailing break -> one window whose ENTIRE content is '---'
```

A window with no quotable words makes the anchored ask fail `isGrounded`,
spending the retry and falling back — costing a user token in byok mode.
Only shows in break-heavy real drafts. Fix: filter break lines out of the
sweep plan as sections already do.

## H9-3 — The exported draft IO seam has no read/write synchronization (S3, latent)

Reproduced 800-race probes against createDraftIo with 8 MB payloads:

```
.bughunt/h9-race2.ts, agent run: full=798 old=1 empty=0 PARTIAL=1
.bughunt/h9-race2.ts, rerun:     full=799 old=1 empty=0 partial=0
```

writeFile truncates then writes, so a load racing a save observes torn or
stale content. NOT reachable over HTTP — server.ts serializes /save+/load
through ioSerial — but loadDraft/saveDraft are exported and used directly by
tests and any non-server caller without protection. Distinct from the
SIGKILL crash-atomicity suspect above: this is a concurrent-reader race, and
it reproduced.

---

# Coverage note

Swept across waves three through five with executed repro evidence: all
heuristic modules (window-stats, cadence), gate/reshape/seed/pick-seed,
coach-sweep reconcile + planning, anchor/text-window/save stack, draft-store,
decorations/editor-access/highlight/inbox/theme/main/sample-draft,
markdown-preview rendering config, EditorApp orchestration angles,
byok/dictation, STT client + model resolution + WAV decode, server routes +
boundary + concurrency + env parsing, seed-bank sqlite/jsonl/client consistency,
query algebra, validation, quote provenance. NOT swept: web/style.css
(cosmetic), scripts/ experiment tooling, docs/, extract/. Test counts stayed
green throughout (29 files / 484 tests at recording time); tsc clean.
