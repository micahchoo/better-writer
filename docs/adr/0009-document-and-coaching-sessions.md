# Document and coaching sessions

Date: 2026-09-05

## Problem

Model changes also changed draft storage and reloaded documents.
Auto-ask and sweep managed overlapping requests through separate editor flags.
Questions returned their source through mutable adapter state.
Annotation identity changed when its offsets moved.

The agent forced one random seed to fit a passage.
A lexical match could pass the gate despite an invented premise.
The app then inferred an annotation location from the generated question.

## Decision

`DocumentSession` owns one fixed storage adapter, a draft revision, annotations, and saves.
`CoachingSession` owns request lifetimes, cancellation, and the captured coach.
React renders their state and sends document or coaching actions.
A model connection change cancels pending coaching but preserves document ownership.

Each ask returns its own question, source, and evidence, or an explicit skip or unavailable result.
Cancellation reaches the provider and invalidates late callbacks.
Auto-ask and sweep share one lifecycle owner and cannot run together.

Annotations have persistent IDs. CodeMirror changes map their spans during live edits.
An edit inside the evidence removes the annotation.
A bounded revision journal maps late results through up to 1,000 edits.
Older results are rejected. Text and context matching remain available for reload recovery.

Browser storage commits the draft and annotations in one versioned snapshot.
Legacy keys remain readable and untouched. Server annotations retain IDs, source labels, and recovery context.

## Agent

Runtime-neutral code in `src/core` owns types, windows, analysis, selection, prompts, and gates.
Local and BYOK modes use the same candidate draw over the exported client bank.
Python remains responsible for seed authoring, validation, and export.
This replaces the runtime subprocess decision in ADR 0004 without replacing Python authoring tools.

The model sees up to three candidate question strings and a passage with an explicit focus.
It selects an applicable candidate or abstains.
Its output includes one question and an exact quote.
Code checks that the quote occurs once in the focus and appears unchanged in the question.
Code computes the offsets. Existing syntax, seed-copy, and echo checks still apply.

A corrective retry includes the rejected response and the failed check.
After a second invalid output, no annotation is created.
Unavailable models produce a separate result. Cancellation produces no fallback.
This replaces the topic-probe fallback in ADR 0005 for the production agent.
The legacy pipeline remains an evaluation baseline.

## Checks and limits

Tests cover cancellation, reversed completion order, model switches, stale evidence, stable IDs, storage migration, and atomic browser saves.
The Bonsai evaluation uses synthetic prose and identical candidate pools across comparison arms.
No evaluation reads the current user draft.

Exact quotes establish where a question points. They do not prove that the question is useful or preserves craft intent.
The model can abstain too often or phrase advice as a question. The evaluation report records these limits.
