# Better Writer

An agent-backed Markdown editor. It asks you one sharp craft question about
the text around your cursor — and never writes a word for you.

Write, and the coach watches. After ~30 new words and a pause, it pulls one
craft lesson from a bank of 1,258 seeds and reshapes it against your actual
sentences: a question addressed to you, in your own words, about your own
paragraph. You answer by revising. It asks again when you want.

## Why

A blank page is the problem. A question is the answer. The model has one job:
ask. It never drafts, never edits, never explains. Your words stay yours.

## Run it

```bash
npm install

# static demo — no model, no server; seeds pulled at random (the GitHub Pages build)
npm run dev

# full mode — one local model reshapes the question against your text
npm start
```

Open http://127.0.0.1:4517.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `BW_LLM_BASE_URL` | `http://127.0.0.1:8088/v1` | OpenAI-compatible endpoint (llama.cpp / Ollama) |
| `BW_LLM_MODEL` | `bonsai-27b` | Model id |
| `BW_STT_MODEL_DIR` | — | Local Parakeet STT dir; dictation hidden without it |
| `BW_HOST` / `BW_PORT` | `127.0.0.1` / `4517` | Bind address |

Real env vars win over a `.env` file (see `.env.example`).

## The two modes

- **Static** — no server, no model. The coach shows a random seed's question
  verbatim. Drafts persist in the browser. This is what GitHub Pages serves.
- **Local** — the server pulls a seed by genre, reshapes it with one local
  model, and mechanically gates the result to a single question. Drafts
  persist to `data/drafts/current.md`.

The client probes `/health` on load and picks the mode itself.

## The seed bank

`seeds/` holds 1,258 craft questions extracted verbatim from three books —
Le Guin's *Steering the Craft*, Stein's *Stein on Writing*, and Alberts'
*Showing & Telling*. Each seed is `{ question, verb, genre, source }`. Only
`question` reaches the model; `verb` and `source` are audit fields that never
do.

## Discipline

- Local models only. No hosted API, ever.
- The model composes freely and commits nothing. A deterministic gate rejects
  anything that is not a single question, retries once, then falls back to a
  topic probe.
- Seed provenance never reaches the model or the page.

See `CONTEXT.md` for the glossary and `docs/adr/` for the decisions.

## Develop

```bash
npm test           # 59 tests: gate, reshape, seed, text-window, trigger, coach
npm run typecheck  # tsc --noEmit
npm run build      # static build to dist/ (relative asset paths, GitHub Pages ready)
```
