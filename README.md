# Better Writer

You write. It asks you one question about what you just wrote. It never touches your words.

Here is a real question the app pinned to a real sentence, using the sample draft it ships with:

> **You wrote:**
> My grandmother cooked with her wrists, not her hands. She lifted the heavy iron skillet with a flick that looked careless and set it on the burner as if it weighed nothing.
>
> **It asked:**
> When you describe her lifting the heavy iron skillet with a flick that "looked careless," does that detail serve the credibility of her skill, or is it simply decorative?

The question stays attached to your sentence until you dismiss it. There is no chat window, no suggested rewrite, no "here is a better version." You do all the writing.

**[Try it in your browser →](https://micahchoo.github.io/better-writer/)** No install, no account, no key.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/editor-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/editor-light.png">
  <img src="docs/assets/editor-light.png" alt="The editor with one question pinned to the phrase 'heavy iron skillet'">
</picture>

## What it never does

- It never writes a sentence for you.
- It never edits your draft.
- It never explains itself or gives advice.
- It never sends your writing to a company. Your draft stays on your machine.

These are not polite instructions in a prompt. The app can only display one question. Anything else the model produces is thrown away.

## Installation

You need [Node](https://nodejs.org) 20 or later.

```bash
git clone https://github.com/micahchoo/better-writer.git
cd better-writer
npm install
npm run dev
```

Open the address the terminal prints. This is the same demo as the link above: no model, no setup.

To get questions written in your own words, you need a model. See [Choose how it thinks](#choose-how-it-thinks).

## Getting started

The app opens on an empty page.

1. Click **Load a sample draft** if you want prose to try it on. Or start typing your own.
2. Keep writing. After about 30 new words and a 20-second pause, one question appears, attached to a sentence.
3. Click any highlighted phrase to read its question.
4. Revise until the question is no longer true, then click **Resolved** to dismiss it.

To question a whole draft at once, click **Sweep draft**. It walks the document one window at a time and pins a question to each. **Clear notes** removes them all.

![A sweep running: the sample draft loads, then questions appear one window at a time](docs/assets/sweep.gif)

Set **asking as** to your genre — fiction, creative-nonfiction, memoir, essay, poetry, or genre-agnostic. It changes which questions you are asked.

> [!NOTE]
> **Sweep draft** and the **Auto-ask** switch need a model, so they only appear when one is connected. In the no-model demo, questions still arrive on their own after a pause.

## Choose how it thinks

| | No model | Your own model | Your own key |
|---|---|---|---|
| **What you get** | A craft question, word for word from the book it came from | The same question, rewritten to quote your actual sentences | The same, through a provider you pay for |
| **You need** | Nothing | A model server on your machine | An API key |
| **Your draft is saved** | In your browser | To `data/drafts/current.md` | In your browser |

The app detects which one it can use and switches by itself.

**Your own model.** Run [llama.cpp](https://github.com/ggml-org/llama.cpp) or [Ollama](https://ollama.com) on `127.0.0.1:8088`, then:

```bash
npm start      # serves http://127.0.0.1:4517
```

**Your own key.** Click the key icon in the top bar and enter your provider, model, and key. It stays in your browser and goes only to the provider you named.

Dictation works in both: locally through Parakeet, or through your provider's transcription endpoint.

## Where the questions come from

1,757 questions, taken word for word from four books on writing craft:

| Book | Author | Questions |
|---|---|---|
| *Stein on Writing* | Sol Stein | 792 |
| *Storycraft* | Jack Hart | 387 |
| *Showing & Telling* | Laurie Alberts | 345 |
| *Steering the Craft* | Ursula K. Le Guin | 233 |

Every question carries the sentence from the book that produced it. That quote is there so the question can be checked against its source. It is never shown to you and never sent to the model, so no book gets to advertise itself in your margin.

<details>
<summary>How one question gets chosen</summary>

The app measures your paragraph before it picks. Seven signals can fire: how much of it is dialogue, whether every sentence runs the same length, how many hedges and `-ly` adverbs it carries, how often you write *felt*, *seemed*, or *noticed*, how heavy the abstract nouns are, and whether the paragraph opens or closes its section.

Those signals lean the choice toward a kind of question. A paragraph full of hedges leans toward questions about cutting. A scene thick with quotes leans toward questions about dialogue.

The lean changes which group it draws from. Inside that group, the draw is even. No question is ranked above another, so the app cannot develop a favorite and repeat it at you.

The model then rewrites the drawn question to quote your sentences. Its output has to pass a check before you see it: one line, one question mark, no lists, and it must quote your words rather than parrot them back. If the output fails, the model gets one more try. If it fails again, you get a fixed question instead, marked as such.

The full vocabulary is in [CONTEXT.md](CONTEXT.md); the decisions behind it are in [docs/adr/](docs/adr/).

</details>

## Settings

Copy [`.env.example`](.env.example) to `.env` and edit it.

| Variable | Default | What it does |
|---|---|---|
| `BW_LLM_BASE_URL` | `http://127.0.0.1:8088/v1` | Your local model endpoint |
| `BW_LLM_MODEL` | `bonsai-27b` | Which model to ask |
| `BW_HOST` | `127.0.0.1` | Address the server binds to |
| `BW_PORT` | `4517` | Port the server binds to |
| `BW_STT_MODEL_DIR` | unset | Parakeet folder; dictation is off without it |

## Development

```bash
npm test           # unit suite
npm run typecheck  # tsc --noEmit
npm run build      # static build into dist/
```

The editor is built on [CodeMirror 6](docs/adr/0008-cm6-editor-substrate.md). Every architectural decision has a short record in [docs/adr/](docs/adr/).

## Contributing

Issues and pull requests are welcome. Three rules hold:

- The model runs on the writer's machine or on their own key. Never ours.
- The model never writes into the draft.
- A book's name and quotes never reach the writer or the model.

Run `npm test && npm run typecheck` before you open a pull request.

## License

MIT. See [LICENSE](LICENSE).
