#!/usr/bin/env python3
"""Generate the cross-language drawer vector fixture.

Builds N=16 deterministic pull cases against seeds/retrieve.py's drawer and
records, for each, the exact seed-id sequence a seeded RNG produces over 5
successive pulls. The fixture is the reference oracle the TypeScript drawer
port (the server /ask -> implVerbs -> `--lean-verbs` path) must reproduce
exactly; tests in seeds/test_retrieve.py replay every case against the current
implementation to keep the oracle in sync.

Cases 0-11 exercise the explicit-preference two-stage drawer core; cases 12-15
exercise the default genre preference (specific-genre cards claim first claim
on half the draws from a mixed pool) that the pull CLI and pickSeed apply when
a genre filter produced a mixed pool. For those cases `preference` is null and
`genre` records the chosen genre.

Run from the repo root:
    python3 scripts/experiment/gen-drawer-vectors.py
Writes scripts/experiment/out/drawer-vectors.json and prints the case count.
"""

import json
import random
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO / "seeds"))

import retrieve  # noqa: E402

OUT = Path(__file__).resolve().parent / "out" / "drawer-vectors.json"

# Distinct verbs from the pinned axis->verb table (IMPL_VERBS in
# web/window-stats.ts). The seven axes (dialogue, rhythm, hedge, filter-word,
# nominal, opening-position, closing-position) collapse to these six distinct
# verb values; pools below span the full set.
IMPL_VERBS = ["concept-form", "elaborate", "cut", "rewrite", "rephrase", "transition"]
GENRES = ["fiction", "poetry", "memoir", "essay", "creative-nonfiction", "genre-agnostic"]
DRAWS = 5  # successive pulls per case with the same seeded rng
SEED0 = 42  # per-case rng seed = SEED0 + case idx
NUM_CASES = 16


def make_seed(case, i, verb, genre):
    return {
        "id": f"v-{case:02d}-{i:03d}",
        "question": f"Case {case} seed {i}.",
        "verb": verb,
        "genre": [genre],
        "source": {"book": "Fixture", "author": "Gen", "chapter": "c", "quote": "q"},
    }


def build_pool(case, n, verbs, genres=GENRES):
    return [make_seed(case, i, verbs[i % len(verbs)], genres[i % len(genres)]) for i in range(n)]


def make_genre_pool(case, n_specific, n_agnostic, genre="fiction"):
    """A mixed pool (already genre-filtered to `genre`): specific cards that
    strictly carry `genre` plus genre-agnostic-only wildcard cards. Both groups
    non-empty -> default_genre_preference engages (specific pile is 'matched')."""
    specific = [
        make_seed(case, i, IMPL_VERBS[i % len(IMPL_VERBS)], genre) for i in range(n_specific)
    ]
    agnostic = [
        make_seed(case, 1000 + i, IMPL_VERBS[i % len(IMPL_VERBS)], "genre-agnostic")
        for i in range(n_agnostic)
    ]
    return specific + agnostic


def case_pool(idx):
    """Return (pool, preference, genre) for case idx. preference is None, or a
    JSON-serializable dict {"match": [verbs...]} with optional "p" (omitted p
    exercises retrieve.pull's default of 0.5). genre is None except for the
    default-genre-preference cases (12-15), where it records the chosen genre
    and preference stays None."""
    if idx == 0:
        # no preference: legacy uniform draw over a mixed pool.
        return build_pool(idx, 24, IMPL_VERBS), None, None
    if idx == 1:
        # match-verbs with default p; matched pile == FLOOR exactly (no shrink).
        return build_pool(idx, 48, IMPL_VERBS), {"match": ["concept-form", "elaborate"]}, None
    if idx == 2:
        # small matched pile (6 < FLOOR) forcing the floor shrink: effective_p 0.375.
        return build_pool(idx, 40, IMPL_VERBS), {"match": ["transition"], "p": 0.5}, None
    if idx == 3:
        # full matched pile: complement empty -> uniform choice over the pool.
        return build_pool(idx, 20, ["rewrite"]), {"match": ["rewrite"], "p": 0.5}, None
    if idx == 4:
        # no preference over a genre-agnostic-heavy pool (wildcard cards).
        pool = build_pool(idx, 24, IMPL_VERBS, genres=["genre-agnostic", "genre-agnostic", "genre-agnostic", "fiction"])
        return pool, None, None
    if idx == 5:
        # match-verbs default p over a pool mixing genre-agnostic wildcard cards.
        return build_pool(idx, 40, IMPL_VERBS), {"match": ["cut", "rephrase"]}, None
    if idx == 6:
        # small matched pile (7 < FLOOR) with p above default: shrink to 7/16 = 0.4375.
        return build_pool(idx, 40, IMPL_VERBS), {"match": ["elaborate"], "p": 0.9}, None
    if idx == 7:
        # empty matched pile (match verb absent) -> uniform fallback over pool.
        return build_pool(idx, 30, ["rewrite", "cut", "rephrase"]), {"match": ["transition"], "p": 0.5}, None
    if idx == 8:
        # no preference over a pool sized exactly at FLOOR.
        return build_pool(idx, 16, IMPL_VERBS), None, None
    if idx == 9:
        # match-verbs default p with matched pile == FLOOR (16 cut / 16 rewrite).
        return build_pool(idx, 32, ["cut", "rewrite"]), {"match": ["cut"]}, None
    if idx == 10:
        # tiny matched pile (1 seed): effective_p 1/16 = 0.0625.
        return build_pool(idx, 40, ["rewrite"] * 39 + ["transition"]), {"match": ["transition"], "p": 0.5}, None
    if idx == 11:
        # match-verbs default p, large matched pile (30) >= FLOOR, full verb span.
        return build_pool(idx, 60, IMPL_VERBS), {"match": ["rewrite", "elaborate", "concept-form"]}, None
    if idx == 12:
        # default genre preference over a mixed pool; specific pile (24) >= FLOOR
        # -> effective_p 0.5. match = strict fiction membership (agnostic-only excluded).
        return make_genre_pool(idx, 24, 24, "fiction"), None, "fiction"
    if idx == 13:
        # mixed pool with a small specific pile (6 < FLOOR): effective_p 6/16 = 0.375.
        return make_genre_pool(idx, 6, 34, "poetry"), None, "poetry"
    if idx == 14:
        # mixed pool with a tiny agnostic-only complement (2): specific still preferred.
        return make_genre_pool(idx, 38, 2, "memoir"), None, "memoir"
    # idx == 15: genre filter over a single-group pool (all specific, no agnostic-only
    # cards) -> default_genre_preference returns None -> legacy uniform draw.
    return build_pool(idx, 40, IMPL_VERBS, genres=["essay"]), None, "essay"


def pref_obj(pref):
    """Turn a serializable preference dict into the runtime object pull() expects."""
    if pref is None:
        return None
    verbs = pref.get("match")
    match = None if verbs is None else (lambda s, vs=frozenset(verbs): s["verb"] in vs)
    obj = {"match": match}
    if "p" in pref:
        obj["p"] = pref["p"]
    return obj


def build_cases():
    cases = []
    for idx in range(NUM_CASES):
        pool, pref, genre = case_pool(idx)
        if genre is not None:
            # Default genre preference path: preference recorded as null and
            # `genre` drives the internal default (mirrored by pickSeed).
            runtime_pref = retrieve.default_genre_preference([genre], pool)
        else:
            runtime_pref = pref_obj(pref)
        rng = random.Random(SEED0 + idx)
        seq = [retrieve.pull(pool, runtime_pref, rng)["id"] for _ in range(DRAWS)]
        cases.append(
            {
                "case": idx,
                "seed": SEED0 + idx,
                "pool": pool,
                "poolIds": [s["id"] for s in pool],
                "preference": pref,
                "genre": genre,
                "expectedSeedIdSequence": seq,
            }
        )
    return cases


def main():
    cases = build_cases()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(cases, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"wrote {len(cases)} drawer vector cases to {OUT}")


if __name__ == "__main__":
    main()
