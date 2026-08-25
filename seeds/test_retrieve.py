#!/usr/bin/env python3
"""Tests for the seeds/retrieve.py drawer module.

Run from the repo root:
    python3 -m unittest discover -s seeds -p 'test_*.py'

Covers the pinned drawer contract: `pull(pool, preference, rng)` two-stage
soft preference with the internal per-seed weighting, wildcard-inside filtering
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

PREFERENCE_WEIGHT = retrieve.PREFERENCE_WEIGHT
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
    if "weight" in pref:
        obj["weight"] = pref["weight"]
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


class PerSeedWeightTest(unittest.TestCase):
    """H2-3: the weight fixes the PER-SEED ratio, whatever the piles measure.

    The old rule set the probability of the PILE, so the per-seed rate was
    0.5/len(matched): it inverted on large matched piles and concentrated tiny
    ones. These tests pin the invariant that replaced it — a matched seed is
    PREFERENCE_WEIGHT times likelier than an unmatched one — at three pile
    shapes chosen to break the old rule.
    """

    def per_seed_ratio(self, n_matched, n_complement, seed_value, draws=40000):
        pool = [seed(i, "cut") for i in range(n_matched)] + [
            seed(i, "rewrite") for i in range(n_matched, n_matched + n_complement)
        ]
        pref = {"match": lambda s: s["verb"] == "cut"}
        rng = random.Random(seed_value)
        hits = sum(1 for _ in range(draws) if retrieve.pull(pool, pref, rng)["verb"] == "cut")
        per_matched = (hits / draws) / n_matched
        per_complement = ((draws - hits) / draws) / n_complement
        return per_matched / per_complement

    def test_balanced_piles(self):
        self.assertAlmostEqual(self.per_seed_ratio(20, 20, 11), PREFERENCE_WEIGHT, delta=0.35)

    def test_large_matched_pile_does_not_invert(self):
        # The fiction shape: 898/563 used to prefer the COMPLEMENT 0.64:1.
        self.assertAlmostEqual(self.per_seed_ratio(90, 56, 13), PREFERENCE_WEIGHT, delta=0.35)

    def test_tiny_matched_pile_is_not_concentrated(self):
        # The poetry shape: 8/580 used to give eight seeds ~51% of all draws.
        pool = [seed(i, "cut") for i in range(8)] + [seed(i, "rewrite") for i in range(8, 588)]
        pref = {"match": lambda s: s["verb"] == "cut"}
        rng = random.Random(17)
        draws = 40000
        hits = sum(1 for _ in range(draws) if retrieve.pull(pool, pref, rng)["verb"] == "cut")
        self.assertLess(hits / draws, 0.10, "tiny matched pile must not dominate")
        self.assertAlmostEqual(self.per_seed_ratio(8, 580, 17), PREFERENCE_WEIGHT, delta=0.5)

    def test_both_piles_represented(self):
        pool = make_pool(40, verbs=("cut", "rewrite"))
        pref = {"match": lambda s: s["verb"] == "cut"}
        rng = random.Random(2)
        seen = {retrieve.pull(pool, pref, rng)["verb"] for _ in range(500)}
        self.assertEqual(seen, {"cut", "rewrite"})

    def test_explicit_weight_overrides_the_default(self):
        pool = make_pool(40, verbs=("cut", "rewrite"))
        pref = {"match": lambda s: s["verb"] == "cut", "weight": 1.0}
        rng = random.Random(23)
        hits = sum(1 for _ in range(4000) if retrieve.pull(pool, pref, rng)["verb"] == "cut")
        # weight 1 == no preference at all: an even split over equal piles.
        self.assertTrue(1850 <= hits <= 2150, hits)


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
        # Per-seed weighting (H2-3): specific is 8 of 48, so its SHARE is
        # 3*8/(3*8+40) = 37.5% — above the ~17% a uniform draw would give,
        # and each specific card is exactly 3x likelier than each agnostic
        # one. The old rule handed the 8-card pile a flat 50%.
        self.assertTrue(0.33 * 4000 <= hits <= 0.42 * 4000, hits)

    def test_cli_pull_wires_default_preference(self):
        # STRUCTURAL, not statistical: 60 subprocess draws cannot separate the
        # weighted rate (37.5%) from uniform (16.7%) — the old version of this
        # test was a 2-sigma coin flip. Assert the CLI reaches the preference
        # path and returns a valid seed; the RATE is pinned in-process, with a
        # seeded RNG and 40k draws, by PerSeedWeightTest and the test below.
        conn, path = make_conn(self._mixed_pool())
        self.addCleanup(conn.close)
        self.addCleanup(os.unlink, path)
        out = cli("pull", "--db", path, "--genre", "fiction", "--n", "1")
        drawn = json.loads(out.stdout)
        self.assertEqual(len(drawn), 1)
        # A --genre fiction pull returns a card that carries fiction OR the
        # genre-agnostic wildcard; both are inside the filtered pool.
        self.assertTrue(
            {"fiction", "genre-agnostic"} & set(drawn[0]["genre"]), drawn[0]["genre"]
        )
        self.assertIsNotNone(
            retrieve.default_genre_preference(["fiction"], self._mixed_pool())
        )

    def test_specific_share_matches_the_weight(self):
        pool = self._mixed_pool()
        pref = retrieve.default_genre_preference(["fiction"], pool)
        specific_ids = {f"seed-{i:03d}" for i in range(8)}
        rng = random.Random(7)
        draws = 40000
        hits = sum(1 for _ in range(draws) if retrieve.pull(pool, pref, rng)["id"] in specific_ids)
        # 3*8 / (3*8 + 40) = 37.5%; a uniform draw over 48 cards gives 16.7%.
        self.assertAlmostEqual(hits / draws, 0.375, delta=0.02)


class DrawerVectorFixtureTest(unittest.TestCase):
    """Replay the cross-language drawer fixture against the current pull().

    Every case records a seeded rng, a pool, a preference shape, and the exact
    5-draw seed-id sequence produced at generation time. Cases 12-15 carry a
    `genre` and a null `preference`, exercising the default genre preference:
    the replay builds that preference via default_genre_preference. Any drift
    in the drawer contract (soft-preference math, per-seed weighting,
    fallbacks, default genre stratification) surfaces as a mismatch here — this is the
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


class SchemaEnforcementTest(unittest.TestCase):
    """H5-1: _validate checked key presence only, so schema.json's enums and
    minLength floors were a spec nothing enforced. An unknown-genre seed is
    permanently unreachable by every genre query and nothing flagged it."""

    def base(self, **kw):
        s = {
            "id": "x1",
            "question": "What is at stake?",
            "verb": "cut",
            "genre": ["fiction"],
            "source": {"book": "b", "author": "a", "chapter": "c", "quote": "q"},
        }
        s.update(kw)
        return s

    def test_rejects_an_unknown_verb(self):
        with self.assertRaisesRegex(ValueError, "unknown verb"):
            retrieve._validate(self.base(verb="teleport"))

    def test_rejects_an_unknown_genre(self):
        with self.assertRaisesRegex(ValueError, "unknown genre"):
            retrieve._validate(self.base(genre=["horror"]))

    def test_rejects_an_empty_question_or_quote(self):
        with self.assertRaisesRegex(ValueError, "question"):
            retrieve._validate(self.base(question="   "))
        with self.assertRaisesRegex(ValueError, "quote"):
            retrieve._validate(
                self.base(source={"book": "b", "author": "a", "chapter": "c", "quote": ""})
            )

    def test_accepts_every_declared_verb_and_genre(self):
        for verb in retrieve.VERBS:
            retrieve._validate(self.base(verb=verb))
        for genre in retrieve.GENRES:
            retrieve._validate(self.base(genre=[genre]))

    def test_the_live_bank_satisfies_the_stricter_validator(self):
        path = _REPO / "seeds" / "bank.jsonl"
        bad = []
        with open(path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    retrieve._validate(json.loads(line))
                except ValueError as e:
                    bad.append(str(e))
        self.assertEqual(bad, [], f"{len(bad)} bank seed(s) fail validation")


class DuplicateIdTest(unittest.TestCase):
    """H5-2: two extraction files carried the same id with DIFFERENT questions.
    The upsert kept whichever landed last and len(rows) reported success either
    way, so a distinct seed vanished from the bank leaving no signal."""

    def seed(self, sid, question):
        return {
            "id": sid,
            "question": question,
            "verb": "cut",
            "genre": ["fiction"],
            "source": {"book": "b", "author": "a", "chapter": "c", "quote": "q"},
        }

    def test_refuses_a_duplicate_id_within_one_batch(self):
        conn, path = make_conn([])
        self.addCleanup(conn.close)
        self.addCleanup(os.unlink, path)
        with self.assertRaisesRegex(ValueError, "duplicate id"):
            retrieve.insert_seeds(conn, [self.seed("d1", "one?"), self.seed("d1", "two?")])

    def test_reports_inserted_and_replaced_separately(self):
        conn, path = make_conn([])
        self.addCleanup(conn.close)
        self.addCleanup(os.unlink, path)
        self.assertEqual(retrieve.insert_seeds(conn, [self.seed("d2", "one?")]), (1, 0))
        self.assertEqual(retrieve.insert_seeds(conn, [self.seed("d2", "two?")]), (0, 1))

    def test_no_extraction_file_shares_an_id_with_another(self):
        self.assertEqual(retrieve.duplicate_ids(), {})


class DirectoryContractTest(unittest.TestCase):
    """H5-4: seeds/*.json is not uniformly a seed artifact. A naive glob
    reported every id in the bank as a duplicate, because client.json is a
    generated export of the very files it was compared against."""

    def test_excludes_generated_and_constants_files(self):
        names = {p.name for p in retrieve.extraction_files()}
        self.assertNotIn("client.json", names)
        self.assertNotIn("schema.json", names)
        self.assertNotIn("vocab.json", names)
        self.assertGreater(len(names), 10)

    def test_every_extraction_file_is_a_list_of_seeds(self):
        for path in retrieve.extraction_files():
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertIsInstance(data, list, path.name)
            for seed in data:
                retrieve._validate(seed)
