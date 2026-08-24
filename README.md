# Better Writer

An agent-backed Markdown editor that asks one sharp craft question about the
text around your cursor. It never writes a word for you.

[![sweep demo](docs/assets/sweep.gif)](#usage)

## Why

Writing coaches help most when they ask instead of tell. Better Writer pins
that idea to your text: a question highlights the exact span it is about,
inside your draft. The model has one job — ask. It never drafts, never edits,
never explains.

## Features

- **One question at a time** — anchored to the block under your cursor.
  **Sweep** walks the whole draft and pins one note per window.
- **Seed bank of 1,757 craft questions** extracted verbatim from Le Guin's
  *Steering the Craft*, Stein's *Stein on Writing*, Alberts' *Showing &
  Telling*, and Hart's *Storycraft*.
- **Ruler-guided pulls** — plain text measurements (dialogue density, sentence
  rhythm, hedge-word rates) steer which intervention verbs the drawer prefers.
  The draw stays random inside the preferred pile.
- **Mechanically gated output** — a deterministic gate rejects anything that is
  not a single grounded question; the model composes freely but commits
  nothing.
- **Three modes, zero config to switch** — static demo, local model, or your
  own provider key (BYOK). Local dictation included.

![editor with an open note](docs/assets/editor.png)

## Installation

```bash
git clone https://github.com/micahchoo/better-writer.git
cd better-writer
npm install
```

Node 20+, npm. Full mode additionally needs any OpenAI-compatible completion
server (llama.cpp, Ollama) on `127.0.0.1:8088`.

## Quickstart

Static demo — no model, no server:

```bash
npm run dev
```

Full mode — build, serve, and reshape each seed against your live text with
one local model:

```bash
npm start
```

Open http://127.0.0.1:4517. Put the caret in a paragraph, click **Ask now**,
and answer by revising until the question stops being true. Click **Sweep
draft** to pin notes across everything you wrote.

Drafts save automatically about a second after you stop typing — local mode to
`data/drafts/current.md`, static mode to browser localStorage.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `BW_LLM_BASE_URL` | `http://127.0.0.1:8088/v1` | OpenAI-compatible endpoint |
| `BW_LLM_MODEL` | `bonsai-27b` | Model id |
| `BW_STT_MODEL_DIR` | — | Local Parakeet STT dir; dictation hidden without it |
| `BW_HOST` / `BW_PORT` | `127.0.0.1` / `4517` | Bind address |

BYOK needs no environment variable: set it in the app's top bar. The key lives
in your browser only.

<details>
<summary>The three modes</summary>

| | Static | Local | BYOK |
|---|---|---|---|
| Server | none | Hono + node:http on `4517` | none |
| Question source | stratified random seed, verbatim | seed pulled by genre + verb lean, reshaped by the model | same drawer in-browser, reshaped against your provider |
| Draft storage | browser localStorage | `data/drafts/current.md` | browser localStorage |
| Dictation | hidden | Parakeet via `/transcribe` | provider `/audio/transcriptions` (openrouter: hidden) |

</details>

## Development

```bash
npm test           # full unit suite
npm run typecheck  # tsc --noEmit
npm run build      # static build to dist/ (GitHub Pages ready)
```

The vocabulary lives in `CONTEXT.md`; the decisions in `docs/adr/`.

## Contributing

Issues and pull requests welcome. Keep the discipline: local models only; the
model composes freely but commits nothing; seed provenance never reaches the
model or the page. Run `npm test && npm run typecheck` before opening a PR.

## License

MIT — see [LICENSE](LICENSE).
