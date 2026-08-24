#!/usr/bin/env python3
"""Tests for the seeds/retrieve.py drawer module.

Run from the repo root:
    python3 -m unittest discover -s seeds -p 'test_*.py'

Covers the pinned drawer contract: `pull(pool, preference, rng)` two-stage
soft preference with the internal FLOOR=16 shrink, wildcard-inside filtering
via `query`, the default genre preference (`default_genre_preference`) that
specific-genre cards claim first claim on half the draws from a mixed
genre-filtered pool, seeded-RNG determinism, empty-pool behavior, and the CLI
`--lean-verbs`/`--genre` wiring on pull/query. Also replays the cross-language
drawer vector fixture (scripts/experiment/out/drawer-vectors.json) that the TS
port must reproduce exactly.
"""

import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_SEEDS_DIR = Path(__file__).resolve().parent
_REPO = _SEEDS_DIR.parent
sys.path.insert(0, str(_SEEDS_DIR))
sys.path.insert(0, str(_REPO))

import retrieve  # noqa: E402

FLOOR = retrieve.FLOOR
VERBS = ("rewrite", "cut", "rephrase")

# Cross-language drawer fixture (scripts/experiment/gen-drawer-vectors.py): the
# recorded oracle the TS drawer port must reproduce. Tested below by replaying
# every case against the current implementation.
FIXTURE = _REPO / "scripts" / "experiment" / "out" / "drawer-vectors.json"


def _decode_pref(pref):
    """Turn a serialized fixture preference back into pull()'s runtime object."""
    if pref is None:
        return None
    verbs = pref.get("match")
    match = None if verbs is None else (lambda s, vs=frozenset(verbs): s["verb"] in vs)
    obj = {"match": match}
    if "p" in pref:
        obj["p"] = pref["p"]
    return obj


def seed(i, verb="rewrite", genre="fiction"):
    return {
        "id": f"seed-{i:03d}",
        "question": f"Question number {i}.",
        "verb": verb,
        "genre": [genre],
        "source": {"book": "Test", "author": "Tester", "chapter": "ch1", "quote": "q"},
    }


def make_pool(n, verbs=VERBS):
    """n seeds whose verbs cycle through `verbs`; ids unique."""
    return [seed(i, verbs[i % len(verbs)]) for i in range(n)]


def make_conn(seeds_list):
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    conn = retrieve.init_db(path)
    retrieve.insert_seeds(conn, seeds_list)
    return conn, path


def cli(*args):
    return subprocess.run(
        [sys.executable, str(_SEEDS_DIR / "retrieve.py"), *args],
        capture_output=True,
        text=True,
        check=True,
        cwd=str(_REPO),
    )


class PullNoPreferenceTest(unittest.TestCase):
    """preference absent == legacy uniform draw."""

    def test_no_preference_equals_rng_choice(self):
        pool = make_pool(30)
        r1, r2 = random.Random(1), random.Random(1)
        self.assertEqual(retrieve.pull(pool, None, r1), r2.choice(pool))
        self.assertEqual(retrieve.pull(pool, None, r1), r2.choice(pool))

    def test_no_preference_ignores_verb_structure(self):
        pool = make_pool(30)  # 10 rewrite / 10 cut / 10 rephrase
        rng = random.Random(7)
        draws = [retrieve.pull(pool, None, rng)["id"] for _ in range(3000)]
        ids = {s["id"] for s in pool}
        self.assertTrue(set(draws).issubset(ids))

    def test_match_key_absent_falls_back_to_uniform(self):
        pool = make_pool(30)
        rng = random.Random(3)
        drawn = retrieve.pull(pool, {"p": 0.5}, rng)
        self.assertIn(drawn["id"], {s["id"] for s in pool})

    def test_empty_matched_pile_falls_back_to_uniform(self):
        pool = make_pool(30, verbs=("rewrite",))
        rng = random.Random(5)
        drawn = retrieve.pull(pool, {"match": lambda s: s["verb"] == "cut"}, rng)
        self.assertEqual(drawn["verb"], "rewrite")  # only complement exists


class TwoStageHitRateTest(unittest.TestCase):
    """~p hit-rate on the matched pile when the floor is respected."""

    def test_hit_rate_about_p_with_floor_respected(self):
        # matched pile (20) >= FLOOR (16): effective_p stays at p = 0.5.
        pool = make_pool(40, verbs=("cut", "rewrite"))  # 20 cut, 20 rewrite
        pref = {"match": lambda s: s["verb"] == "cut", "p": 0.5}
        rng = random.Random(11)
        hits = sum(1 for _ in range(2000) if retrieve.pull(pool, pref, rng)["verb"] == "cut")
        # expected ~1000 (effective_p == p == 0.5, no shrink); std ~ 22
        self.assertTrue(880 <= hits <= 1120, hits)

    def test_both_piles_represented(self):
        pool = make_pool(40, verbs=("cut", "rewrite"))
        pref = {"match": lambda s: s["verb"] == "cut", "p": 0.5}
        rng = random.Random(2)
        seen = {retrieve.pull(pool, pref, rng)["verb"] for _ in range(500)}
        self.assertEqual(seen, {"cut", "rewrite"})


class FloorShrinkTest(unittest.TestCase):
    """effective_p shrinks when matched_count / FLOOR < p."""

    def test_shrink_below_floor(self):
        # 4 matched / 36 complement: effective_p = min(0.5, 4/16) = 0.25.
        pool = [seed(i, "cut") for i in range(4)] + [seed(i, "rewrite") for i in range(4, 40)]
        pref = {"match": lambda s: s["verb"] == "cut", "p": 0.5}
        rng = random.Random(13)
        hits = sum(1 for _ in range(4000) if retrieve.pull(pool, pref, rng)["verb"] == "cut")
        # expected ~1000 (effective_p 0.25), NOT 2000. std ~ 27.
        self.assertTrue(850 <= hits <= 1150, hits)

    def test_no_shrink_at_or_above_floor(self):
        # 8 matched == FLOOR/2: effective_p = min(0.5, 8/16) = 0.5 (no shrink).
        pool = [seed(i, "cut") for i in range(8)] + [seed(i, "rewrite") for i in range(8, 40)]
        pref = {"match": lambda s: s["verb"] == "cut", "p": 0.5}
        rng = random.Random(17)
        hits = sum(1 for _ in range(2000) if retrieve.pull(pool, pref, rng)["verb"] == "cut")
        # expected ~1000 at effective_p 0.5 (not shrunk to 0.25).
        self.assertTrue(880 <= hits <= 1120, hits)


class DeterminismTest(unittest.TestCase):
    """Same seeded RNG + same pool/preference -> identical sequence."""

    def test_deterministic_under_seeded_random(self):
        pool = make_pool(40, verbs=("cut", "rewrite"))
        pref = {"match": lambda s: s["verb"] == "cut", "p": 0.5}
        r1, r2 = random.Random(42), random.Random(42)
        seq1 = [retrieve.pull(pool, pref, r1)["id"] for _ in range(100)]
        seq2 = [retrieve.pull(pool, pref, r2)["id"] for _ in range(100)]
        self.assertEqual(seq1, seq2)

    def test_default_p_is_half(self):
        pref = {"match": lambda s: True}  # p omitted -> 0.5
        pool = make_pool(32, verbs=("cut", "rewrite"))
        rng = random.Random(9)
        self.assertIsNotNone(retrieve.pull(pool, pref, rng))


class WildcardInsideTest(unittest.TestCase):
    """genre-agnostic wildcard handled inside query (callers don't pre-split)."""

    def test_genre_agnostic_matches_any_genre(self):
        pool = make_pool(3, verbs=("rewrite",))
        pool[0]["genre"] = ["genre-agnostic"]
        pool[1]["genre"] = ["fiction"]
        pool[2]["genre"] = ["poetry"]
        conn, path = make_conn(pool)
        try:
            got = {s["id"] for s in retrieve.query(conn, genres=["poetry"])}
            self.assertIn(pool[0]["id"], got)  # wildcard matches
            self.assertNotIn(pool[1]["id"], got)
            self.assertIn(pool[2]["id"], got)
        finally:
            conn.close()
            os.unlink(path)


class EmptyPoolTest(unittest.TestCase):
    """Empty pool behavior unchanged: CLI pull prints an empty JSON array."""

    def test_empty_pool_cli(self):
        conn, path = make_conn([])
        try:
            out = cli("pull", "--db", path, "--genre", "nonexistent", "--n", "3")
            self.assertEqual(json.loads(out.stdout), [])
            self.assertIn("[]", out.stdout)
        finally:
            conn.close()
            os.unlink(path)

    def test_query_empty_returns_empty_list(self):
        conn, path = make_conn([])
        try:
            self.assertEqual(retrieve.query(conn, genres=["fiction"]), [])
        finally:
            conn.close()
            os.unlink(path)

    def test_pull_requires_nonempty_pool(self):
        with self.assertRaises(ValueError):
            retrieve.pull([])


class CliLeanVerbsTest(unittest.TestCase):
    """--lean-verbs on pull (soft two-stage) and query (listing filter)."""

    def setUp(self):
        # 20 cut + 20 rewrite, all fiction.
        pool = [seed(i, "cut") for i in range(20)] + [seed(i, "rewrite") for i in range(20, 40)]
        self.conn, self.path = make_conn(pool)
        self.addCleanup(self.conn.close)
        self.addCleanup(os.unlink, self.path)

    def test_pull_lean_verbs_soft_preference(self):
        out = cli("pull", "--db", self.path, "--genre", "fiction", "--n", "10", "--lean-verbs", "cut")
        picked = json.loads(out.stdout)
        self.assertEqual(len(picked), 10)
        self.assertEqual(len({s["id"] for s in picked}), 10)  # distinct
        verbs = {s["verb"] for s in picked}
        # soft, not exclusive: cut is preferred (matched pile) but rewrite appears.
        self.assertIn("cut", verbs)
        self.assertIn("rewrite", verbs)

    def test_pull_lean_verbs_full_complement(self):
        # matched pile empty (no 'rephrase' seeds): degrades to uniform over pool.
        out = cli("pull", "--db", self.path, "--genre", "fiction", "--n", "5", "--lean-verbs", "rephrase")
        picked = json.loads(out.stdout)
        self.assertEqual(len(picked), 5)
        for s in picked:
            self.assertIn(s["verb"], {"cut", "rewrite"})

    def test_query_lean_verbs_filters_listing(self):
        out = cli("query", "--db", self.path, "--genre", "fiction", "--lean-verbs", "cut,rephrase")
        rows = json.loads(out.stdout)
        self.assertEqual(len(rows), 20)
        self.assertEqual({s["verb"] for s in rows}, {"cut"})

    def test_query_lean_verbs_single(self):
        out = cli("query", "--db", self.path, "--lean-verbs", "cut")
        rows = json.loads(out.stdout)
        self.assertEqual(len(rows), 20)
        self.assertTrue(all(s["verb"] == "cut" for s in rows))


class LegacyCliTest(unittest.TestCase):
    """Legacy pull/query invocations keep their semantics."""

    def setUp(self):
        pool = make_pool(30)  # 10 each of rewrite/cut/rephrase
        self.conn, self.path = make_conn(pool)
        self.addCleanup(self.conn.close)
        self.addCleanup(os.unlink, self.path)

    def test_legacy_pull_n_distinct_members(self):
        out = cli("pull", "--db", self.path, "--genre", "fiction", "--n", "5")
        picked = json.loads(out.stdout)
        self.assertEqual(len(picked), 5)
        self.assertEqual(len({s["id"] for s in picked}), 5)
        ids = {s["id"] for s in retrieve.query(self.conn, genres=["fiction"])}
        self.assertTrue({s["id"] for s in picked}.issubset(ids))

    def test_legacy_verb_hard_filter(self):
        out = cli("pull", "--db", self.path, "--genre", "fiction", "--verb", "cut", "--n", "2")
        picked = json.loads(out.stdout)
        self.assertTrue(all(s["verb"] == "cut" for s in picked))

    def test_legacy_query_verb_exact(self):
        out = cli("query", "--db", self.path, "--verb", "cut")
        rows = json.loads(out.stdout)
        self.assertEqual(len(rows), 10)
        self.assertTrue(all(s["verb"] == "cut" for s in rows))


class DefaultGenrePreferenceTest(unittest.TestCase):
    """Default genre preference on a mixed genre-filtered pool.

    When a --genre filter produces a pool with BOTH specific-genre cards and
    genre-agnostic-only wildcard cards, the pull CLI (and pickSeed) apply a
    default two-stage preference so specific-genre cards claim first claim on
    half the draws. A single-group pool, an all-agnostic pool, or a bare
    full-bank pull (no genre filter) keeps the legacy uniform draw.
    """

    def _mixed_pool(self):
        # 8 specific 'fiction' + 40 agnostic-only: specific is a clear minority,
        # so the preference lifts it well above its ~17% uniform share.
        pool = [seed(i, "rewrite", "fiction") for i in range(8)]
        pool += [seed(1000 + i, "rewrite", "genre-agnostic") for i in range(40)]
        return pool

    def test_engages_on_mixed_pool_with_strict_match(self):
        pref = retrieve.default_genre_preference(["fiction"], self._mixed_pool())
        self.assertIsNotNone(pref)
        matched = [s for s in self._mixed_pool() if pref["match"](s)]
        # match excludes agnostic-only cards: only the 8 specific-fiction ids.
        self.assertEqual({s["id"] for s in matched}, {f"seed-{i:03d}" for i in range(8)})

    def test_returns_none_for_single_group_pool(self):
        all_specific = [seed(i, "rewrite", "fiction") for i in range(30)]
        self.assertIsNone(retrieve.default_genre_preference(["fiction"], all_specific))
        all_agnostic = [seed(i, "rewrite", "genre-agnostic") for i in range(30)]
        self.assertIsNone(retrieve.default_genre_preference(["fiction"], all_agnostic))

    def test_returns_none_without_genre_filter(self):
        # bare full-bank pull (no chosen genre) keeps the legacy uniform draw.
        self.assertIsNone(retrieve.default_genre_preference([], self._mixed_pool()))
        self.assertIsNone(retrieve.default_genre_preference(None, self._mixed_pool()))

    def test_draw_prefers_specific_cards(self):
        pool = self._mixed_pool()
        pref = retrieve.default_genre_preference(["fiction"], pool)
        self.assertIsNotNone(pref)
        rng = random.Random(123)
        specific_ids = {f"seed-{i:03d}" for i in range(8)}
        hits = sum(
            1 for _ in range(4000) if retrieve.pull(pool, pref, rng)["id"] in specific_ids
        )
        # effective_p 0.5 over a pool where specific is 8/48: specific gets
        # ~50% of draws (uniform would give ~17%). std ~ 32.
        self.assertTrue(0.42 * 4000 <= hits <= 0.58 * 4000, hits)

    def test_cli_pull_wires_default_preference(self):
        conn, path = make_conn(self._mixed_pool())
        self.addCleanup(conn.close)
        self.addCleanup(os.unlink, path)
        specific_ids = {f"seed-{i:03d}" for i in range(8)}
        draws = 60
        hits = 0
        for _ in range(draws):
            out = cli("pull", "--db", path, "--genre", "fiction", "--n", "1")
            s = json.loads(out.stdout)[0]
            if s["id"] in specific_ids:
                hits += 1
        # expected ~30/60 (50%); a uniform draw would give ~10/60.
        self.assertGreater(hits, draws * 0.30, f"{hits}/{draws} specific")


class DrawerVectorFixtureTest(unittest.TestCase):
    """Replay the cross-language drawer fixture against the current pull().

    Every case records a seeded rng, a pool, a preference shape, and the exact
    5-draw seed-id sequence produced at generation time. Cases 12-15 carry a
    `genre` and a null `preference`, exercising the default genre preference:
    the replay builds that preference via default_genre_preference. Any drift
    in the drawer contract (soft-preference math, floor shrink, fallbacks,
    default genre stratification) surfaces as a mismatch here — this is the
    oracle the TS port must match.
    """

    def test_every_fixture_case_replays_identically(self):
        with open(FIXTURE, encoding="utf-8") as f:
            cases = json.load(f)
        self.assertGreater(len(cases), 0)
        for case in cases:
            with self.subTest(case=case["case"]):
                pool = case["pool"]
                pref = _decode_pref(case["preference"])
                if case.get("genre"):
                    pref = retrieve.default_genre_preference([case["genre"]], pool)
                rng = random.Random(case["seed"])
                seq = [
                    retrieve.pull(pool, pref, rng)["id"]
                    for _ in range(len(case["expectedSeedIdSequence"]))
                ]
                self.assertEqual(seq, case["expectedSeedIdSequence"])
                # every drawn id must come from the recorded pool
                ids = {s["id"] for s in pool}
                self.assertTrue(set(seq).issubset(ids), seq)


if __name__ == "__main__":
    unittest.main()
