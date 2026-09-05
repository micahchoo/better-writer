# Bonsai agent evaluation

Date: 2026-09-05

The selected agent returned six questions with exact evidence across eight synthetic passages.
It abstained on the deliberately unrelated inventory passage. It rejected the essay response after two evidence failures.

## Setup

- Model: `bonsai-27b`, served by llama.cpp at `http://127.0.0.1:8088/v1`.
- Temperature: `0`, with a 512-token output limit. Production uses these same generation settings.
- Candidate draw seed: `20260905`. Each arm uses the same candidate pool for each fixture.
- Baseline: the original single-seed reshape pipeline, using the first candidate.
- Selected agent: up to three candidates, applicability selection, exact evidence, abstention, and one corrective retry.
- Data: synthetic prose only. The evaluation never reads or saves the current user draft.

## Results

| Measure | Baseline | Selected agent |
|---|---:|---:|
| Model questions displayed | 7 | 6 |
| Fixed fallback questions | 1 | 0 |
| Explicit no-fit results | 0 | 1 |
| Invalid output withheld | 0 | 1 |
| Model calls | 10 | 10 |
| Median latency per fixture | 1.68 s | 3.27 s |

Each of the six accepted questions contains its exact evidence quote.
Each quote occurs once inside the supplied focus. Code computes the offsets.
The baseline has no equivalent evidence contract.

| Fixture | Selected result | Calls |
|---|---|---:|
| memoir-detail | Question with exact evidence | 1 |
| dialogue-subtext | Question with exact evidence | 1 |
| essay-abstraction | invalid-output | 2 |
| repetitive-rhythm | Question with exact evidence | 2 |
| poetry | Question with exact evidence | 1 |
| intentional-hedges | Question with exact evidence | 1 |
| no-applicable-seed | no-fit | 1 |
| instruction-in-prose | Question with exact evidence | 1 |

The clock fixture initially changed `The` to `the` inside its quote.
The retry included the rejected response and recovered the exact original phrase.
The essay response still changed quote wording after its retry. The agent withheld that annotation.

The inventory case shows why lexical overlap is insufficient.
The baseline invented a relationship between characters to fit its viewpoint seed.
The selected agent returned no-fit instead.

## Question quality

The selected questions explore effects instead of prescribing rewrites in this sample.
Several questions still weaken the selected craft concern into a generic question about reader effect.
For example, the dialogue question asks about hiding a receipt, although its selected seed concerns characterization at rest.

The [AI rubric review](bonsai-review.json) records relevance, craft intent, prescription, and invented premises.
The reviewer saw shuffled outputs without arm labels, but candidate indices could reveal assignment.
The reviewer also saw earlier outputs. This is not an independent human assessment.

Mechanical acceptance is not a measure of writing quality.
These eight fixtures also served as prompt-development examples, so this is a calibration report, not a held-out benchmark.
One run per fixture cannot establish general quality or latency.
Local prompt caching can affect the latency comparison. No provider billing was involved.

## HTTP check

The [HTTP report](bonsai-server.json) exercises a temporary local server, the LocalCoach adapter, and Bonsai.
It checks a grounded question on the memoir fixture and caller cancellation.
The server uses port `49882` and closes after the test. The test never calls `/save`.

## Reproduce

```bash
npm run eval:agent
BW_LLM_BASE_URL=http://127.0.0.1:8088/v1 BW_LLM_MODEL=bonsai-27b node --import tsx scripts/eval-server.ts
```

`BW_EVAL_ONLY` selects comma-separated fixture names without changing their candidate pools.
`BW_EVAL_OUTPUT` selects the output file. `BW_EVAL_LIMIT` restricts the fixture prefix.

The [selected trials](bonsai-agent.json) include candidates, results, rejected outputs, call counts, and latency.
Other `bonsai-agent-*.json` files retain calibration runs, including the shorter prompt that reintroduced an invented inventory premise.

## Code checks

- TypeScript: 609 passing tests across 37 files.
- Python seed tools: 39 passing tests.
- Typecheck and production build: passed.
- Git whitespace check: passed.
