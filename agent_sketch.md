# Writer-seed consumer agent

The executable agent is [src/core/agent.ts](src/core/agent.ts).
`AGENT_SYSTEM` and `buildCandidatePrompt` contain the current prompt.
This file describes the contract. It does not duplicate the prompt.

## Input

A request supplies contiguous passage text, focus offsets, genre, and section position.
Shared selection code draws up to three distinct craft questions.
Only those question strings enter the model prompt.
Seed IDs, verbs, genres, and source provenance remain outside it.

## Output

The model selects a request-local candidate number and returns one question with an exact evidence quote.
It can return an abstention when no candidate fits.
Code computes evidence offsets and accepts only unique matches inside the focus.
The question must contain the same quote.

Invalid output gets one corrective retry with the rejected response and a specific correction.
Two invalid attempts produce no annotation. Transport failure produces an unavailable result.
Cancellation propagates through transport and prevents a retry or annotation.

The model has no operation that changes the draft.
Question syntax and evidence checks cannot prove relevance, intent preservation, or the absence of prescriptive advice.
The Bonsai evaluation compares those qualities separately from mechanical acceptance.

## Runtime

Local and BYOK adapters share selection and agent code.
Python owns seed authoring, validation, and export. The runtime reads the exported client bank.
The static demo displays a seed without a model.
The legacy single-seed pipeline remains available for evaluation only.
