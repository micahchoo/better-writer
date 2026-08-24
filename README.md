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
- It never phones home. There is no account, no telemetry, and no server of ours between you and your words.

These are not polite instructions in a prompt. The app can only display one question. Anything else the model produces is thrown away.

**Where your words go.** With no model, or with your own model on your own machine, nothing leaves it. If you connect your own API key, that changes: the paragraph around your cursor goes to the provider you picked, and **Sweep draft** sends the whole draft that way, one window at a time. Dictation audio goes to the same provider. That is what the key is for, and you pay for every call. Your draft *file* is never uploaded in any mode — it lives in your browser or on your disk.

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
> **Sweep draft** appears once a model is connected. The **Auto-ask** switch appears only when the model runs on your own machine. In the no-model demo, questions still arrive on their own after a pause.

## Choose how it thinks

| | No model | Your own model | Your own key |
|---|---|---|---|
| **What you get** | A question from the bank, exactly as written | The same question, rewritten to quote your actual sentences | The same, through a provider you pay for |
| **You need** | Nothing | A model server on your machine | An API key |
| **Your draft is saved** | In your browser | To `data/drafts/current.md` | In your browser |
| **Your prose leaves your machine** | Never | Never | Yes — to your provider |

The app detects which one it can use and switches by itself.

**Your own model.** Run [llama.cpp](https://github.com/ggml-org/llama.cpp) or [Ollama](https://ollama.com) on `127.0.0.1:8088`, then:

```bash
npm start      # serves http://127.0.0.1:4517
```

**Your own key.** Click the key icon in the top bar and pick OpenRouter, OpenAI, Groq, or any OpenAI-compatible URL, then enter your model and key. The key is kept in your browser and is sent only to the base URL you named.

Dictation works with a local Parakeet model, or through your provider's transcription endpoint. OpenRouter serves no audio route, so on OpenRouter the **Dictate** button hides rather than fail.

## Where the questions come from

A bank of 1,757 craft questions written for this project, each tagged by genre and by the kind of change it asks for:

| Asks you to | Questions |
|---|---|
| rewrite | 605 |
| form a concept | 422 |
| cut | 229 |
| elaborate | 202 |
| rephrase | 125 |
| transition | 109 |
| elucidate | 65 |

The bank is the only place a question can start. The model never invents one — it takes a question from the bank and rewrites it to quote your sentences. You see a question about your own paragraph and nothing else.

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
- Seed provenance stays invisible: it reaches neither the writer nor the model.

Run `npm test && npm run typecheck` before you open a pull request.

## License

MIT. See [LICENSE](LICENSE).
