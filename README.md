# Better Writer

A local-first Markdown editor whose only intelligence is the question it asks.
It reads your paragraph through fixed measurements, picks one craft question
that fits what the measurements say, and pins that question to your own
sentences. It never writes, edits, or explains — you do all of it.

[![sweep demo](docs/assets/sweep.gif)](#how-a-question-reaches-your-page)

## What makes it a product, not a chat box

Three guarantees, enforced by code rather than intention:

1. **The model asks, nothing else.** Every reply must pass a mechanical gate:
   exactly one question, grounded in your text, ending in `?`. Failure means
   one corrective retry, then a fixed fallback probe. A question reaches you
   only after that gate.
2. **Selection is measured, not vibes.** Six rulers run over your paragraph —
   dialogue density, sentence-length variance, hedge-word rate, filter-verb
   rate, nominalization load, position inside the section. They steer which
   *kind* of question gets drawn: hedge-storms lean toward trim questions,
   quote-heavy scenes toward scene-and-dialogue ones.
3. **The draw stays honest.** Whatever pile the rulers prefer, the card comes
   out of it by uniform shuffle. No ranking, no favorites, no repeated pet
   advice — narrowing changes *which shelf*, never *which card*.

## Where the questions come from

1,757 cards distilled verbatim from four craft books — Ursula K. Le Guin's
*Steering the Craft*, Sol Stein's *Stein on Writing*, Laurie Alberts'
*Showing & Telling*, Jack Hart's *Storycraft*. Each card carries its source
quote for auditing; neither the quote nor the book's name ever reaches the
model or your screen.

## Three ways to run it

| | Static | Local | Bring your own key |
|---|---|---|---|
| Intelligence | none — draws cards verbatim | one local model reshapes each card against your words | your OpenAI-compatible provider does, in your browser |
| Draft storage | browser localStorage | `data/drafts/current.md` | browser localStorage |
| Needs | nothing | llama.cpp / Ollama on `127.0.0.1:8088` | a provider key, set in the top bar |

The client probes and picks a mode by itself. Dictation ships too — Parakeet
locally, or your provider's transcription endpoint when a key supports it.

## Run it

```bash
git clone https://github.com/micahchoo/better-writer.git
cd better-writer
npm install
```

Node 20+. Then either:

```bash
npm run dev    # static demo, no model needed
```

or, with a completion server running locally:

```bash
npm start      # serves http://127.0.0.1:4517
```

Put the caret in a paragraph and click **Ask now**. Revise until the pinned
question stops being true, dismiss it. **Sweep draft** repeats that across the
whole document, window by window.

Configuration lives in environment variables (`BW_LLM_BASE_URL`,
`BW_LLM_MODEL`, `BW_HOST`, `BW_PORT`, `BW_STT_MODEL_DIR`) — see
[`.env.example`](.env.example).

![editor with an open note](docs/assets/editor.png)

## Under the hood

- Editor substrate: [CodeMirror 6](docs/adr/0008-cm6-editor-substrate.md), the
  fork decision in [ADR 0003](docs/adr/0003-buffertab-fork-storage-and-cm6-seam.md).
- The rulers, drawer, gate, and seed vocabulary are documented in
  [`CONTEXT.md`](CONTEXT.md); the decisions behind them in `docs/adr/`.

```bash
npm test           # full unit suite, including drawer vectors and rulers
npm run typecheck  # tsc --noEmit
npm run build      # static build to dist/ (GitHub Pages ready)
```

## Contributing

Issues and pull requests welcome. The rules are short: local models only; the
model never commits anything; seed provenance stays invisible. Run
`npm test && npm run typecheck` before opening a PR.

## License

MIT — see [LICENSE](LICENSE).
