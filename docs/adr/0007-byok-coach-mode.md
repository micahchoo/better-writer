# BYOK coach mode in the browser

A third coach mode, `byok`: the writer pastes an OpenAI-compatible provider
key into the top bar, and the whole ask pipeline — seed pick, reshape,
mechanical gate, topic-probe fallback, sweep — runs client-side against that
provider. The key is stored in localStorage and is only ever sent to the
configured base URL. The local-models rule holds where it matters: no server
we run ever touches prose or keys. Draft persistence stays browser-local
(`makeDraftStore` routes every non-`local` mode to localStorage). Dictation
rides the same encoded-WAV bytes to the provider's
`/audio/transcriptions`; OpenRouter serves no audio route, so its dictation
button hides instead of lying. Auto-ask stays `local`-only on purpose: a
background timer must not spend the writer's tokens without a click.
