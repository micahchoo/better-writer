#!/usr/bin/env python3
"""Storage and retrieval for the writer-seed bank.

Each row of the `seeds` table flattens the canonical schema (see
seeds/schema.json): `genre` is stored as a JSON array string, and `source` is
flattened into book/author/chapter/quote columns. When read back, rows are
reconstructed into the canonical seed shape (genre as a list, source nested),
so callers never touch the flattened form.

The runtime payload for the consumer model is `question` only; `verb` and
`source` are audit/integrity fields. Query and pull match on the
runtime-relevant axis (genre) and optionally on verb.

The drawer is `pull(pool, preference, rng)`: it draws a single seed from an
already-filtered pool, optionally soft-preferencing a subset. Hard filtering
(genre/verb) lives in `query`, so callers never pre-split piles; the
genre-agnostic wildcard is handled inside `query`/`_matches`. When a --genre
filter produces a genuinely mixed pool (specific-genre cards AND
genre-agnostic-only cards), the pull CLI applies a default genre preference
(`default_genre_preference`) so specific-genre cards claim first claim on half
the draws; --lean-verbs overrides it (genre stratification folded OUT).

stdlib only: sqlite3, json, argparse, random.
"""

import argparse
import json
import random
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "bank.sqlite"

# How much likelier a PREFERRED seed is than a non-preferred one, per seed.
# Not a pile-level probability: the two-stage draw derives its stage-one
# probability from this weight and the two pile sizes, so the per-seed ratio is
# exactly PREFERENCE_WEIGHT whatever the piles measure. See pull().
PREFERENCE_WEIGHT = 3.0

_CREATE = """
CREATE TABLE IF NOT EXISTS seeds (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    verb TEXT NOT NULL,
    genre TEXT NOT NULL,
    book TEXT NOT NULL,
    author TEXT NOT NULL,
    chapter TEXT NOT NULL,
    quote TEXT NOT NULL
)
"""

_COLS = ("id", "question", "verb", "genre", "book", "author", "chapter", "quote")


# Enumerations and length floors declared by schema.json. Kept here as the
# ENFORCED copy: _validate used to check key presence and non-empty genres
# only, so an unknown verb, an unknown genre, or an empty question all stored
# cleanly (H5-1). An unknown-genre seed is permanently unreachable by every
# genre query and nothing flagged it. Keep in step with seeds/schema.json.
VERBS = frozenset(
    ("rewrite", "elaborate", "elucidate", "cut", "transition", "concept-form", "rephrase")
)
GENRES = frozenset(
    ("fiction", "creative-nonfiction", "memoir", "essay", "poetry", "genre-agnostic")
)


# --- the seeds/ directory contract (H5-4) ---
#
# `seeds/*.json` is NOT uniformly "a seed artifact", and pretending it is makes
# every glob-based validator false-positive. Three kinds of file live here:
#
#   extraction files  a JSON LIST of seeds, one per craft-book chapter — the
#                     only inputs `add` should ever be pointed at;
#   generated exports client.json (the whole bank, re-emitted for the browser);
#   constants         schema.json (the contract) and vocab.json (genres/verbs).
#
# The contract was implicit, so a naive glob over seeds/*.json reported 1638
# "duplicate ids" — every id in the bank, once from its chapter file and once
# from the generated export. `extraction_files()` is the explicit rule.
NON_EXTRACTION_FILES = frozenset(("schema.json", "vocab.json", "client.json"))


def extraction_files(directory=None):
    """Every seeds/*.json that is an extraction file, sorted by name."""
    directory = Path(directory) if directory else Path(__file__).resolve().parent
    return sorted(
        p for p in directory.glob("*.json") if p.name not in NON_EXTRACTION_FILES
    )


def duplicate_ids(directory=None):
    """Ids that appear in more than one extraction file, mapped to those files.

    Two chapter files carried the same id with DIFFERENT questions; the upsert
    kept whichever landed last and the ch12-15 variant was lost from the bank
    with no signal at all (H5-2). insert_seeds now refuses a duplicate within
    one batch; this catches the across-file case, which no single call sees.
    """
    seen = {}
    for path in extraction_files(directory):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, list):
            continue
        for seed in data:
            if isinstance(seed, dict) and "id" in seed:
                seen.setdefault(seed["id"], []).append(path.name)
    return {sid: files for sid, files in seen.items() if len(files) > 1}


def _validate(seed):
    """Check a seed dict against the canonical schema; raise ValueError.

    Enforces what schema.json DECLARES, not just the shape: required keys,
    the verb and genre enumerations, and the non-empty floors on question and
    quote. A seed that fails here never reaches the bank.
    """
    missing = [k for k in ("id", "question", "verb", "genre", "source") if k not in seed]
    if missing:
        raise ValueError(f"seed missing required key(s) {missing}: {seed.get('id', '<no id>')!r}")
    sid = seed["id"]
    src = seed["source"]
    missing = [k for k in ("book", "author", "chapter", "quote") if k not in src]
    if missing:
        raise ValueError(f"seed {sid!r} source missing key(s) {missing}")
    if not isinstance(seed["genre"], list) or not seed["genre"]:
        raise ValueError(f"seed {sid!r} genre must be a non-empty list")
    if not isinstance(seed["question"], str) or not seed["question"].strip():
        raise ValueError(f"seed {sid!r} question must be a non-empty string")
    if not isinstance(src["quote"], str) or not src["quote"].strip():
        raise ValueError(f"seed {sid!r} source.quote must be a non-empty string")
    if seed["verb"] not in VERBS:
        raise ValueError(f"seed {sid!r} has unknown verb {seed['verb']!r}; expected one of {sorted(VERBS)}")
    unknown = [g for g in seed["genre"] if g not in GENRES]
    if unknown:
        raise ValueError(f"seed {sid!r} has unknown genre(s) {unknown}; expected from {sorted(GENRES)}")


def init_db(path):
    """Create the seeds table (idempotent) and return an open connection."""
    conn = sqlite3.connect(path)
    conn.execute(_CREATE)
    conn.commit()
    return conn


def _row_to_seed(row):
    return {
        "id": row[0],
        "question": row[1],
        "verb": row[2],
        "genre": json.loads(row[3]),
        "source": {"book": row[4], "author": row[5], "chapter": row[6], "quote": row[7]},
    }


def insert_seeds(conn, seeds):
    """Upsert seed objects by id; accept a single object or a list.

    Returns (inserted, replaced): how many ids were new and how many overwrote
    an existing row. The count alone hid a real loss — two extraction files
    carried the same id with DIFFERENT questions, the upsert kept whichever
    landed last, and len(rows) reported success either way (H5-2). A duplicate
    id WITHIN one call is a mistake in the input and raises.
    """
    if isinstance(seeds, dict):
        seeds = [seeds]
    seeds = list(seeds)
    seen = {}
    for s in seeds:
        sid = s.get("id")
        if sid in seen:
            raise ValueError(
                f"duplicate id {sid!r} in this batch: "
                f"{seen[sid]!r} and {s.get('question')!r} cannot both be stored"
            )
        seen[sid] = s.get("question")
    rows = []
    for s in seeds:
        _validate(s)
        rows.append(
            (
                s["id"],
                s["question"],
                s["verb"],
                json.dumps(s["genre"]),
                s["source"]["book"],
                s["source"]["author"],
                s["source"]["chapter"],
                s["source"]["quote"],
            )
        )
    ids = [r[0] for r in rows]
    existing = set()
    for i in range(0, len(ids), 500):
        chunk = ids[i : i + 500]
        cur = conn.execute(
            f"SELECT id FROM seeds WHERE id IN ({','.join('?' * len(chunk))})", chunk
        )
        existing.update(r[0] for r in cur.fetchall())
    inserted = len(ids) - len(existing)
    conn.executemany(
        f"""INSERT INTO seeds ({", ".join(_COLS)})
            VALUES ({", ".join("?" * len(_COLS))})
            ON CONFLICT(id) DO UPDATE SET
              question=excluded.question, verb=excluded.verb, genre=excluded.genre,
              book=excluded.book, author=excluded.author, chapter=excluded.chapter,
              quote=excluded.quote""",
        rows,
    )
    conn.commit()
    return inserted, len(rows) - inserted


def _all(conn):
    cur = conn.execute(f"SELECT {', '.join(_COLS)} FROM seeds ORDER BY id")
    return [_row_to_seed(r) for r in cur.fetchall()]


def _matches(seed, genres, verb):
    if genres and "genre-agnostic" not in seed["genre"] and not (set(seed["genre"]) & set(genres)):
        return False
    if verb is not None and seed["verb"] != verb:
        return False
    return True


def _parse_verbs(value):
    """Normalize a verb-set argument (comma string or iterable) to a set."""
    if isinstance(value, str):
        return {v.strip() for v in value.split(",") if v.strip()}
    return set(value)


def _lean_preference(lean_verbs):
    """Build a soft preference for --lean-verbs from its comma-set value."""
    verbs = _parse_verbs(lean_verbs)
    return {"match": lambda s: s["verb"] in verbs}


def default_genre_preference(genres, pool):
    """Default soft preference when a genre filter produced a mixed pool.

    Called by the pull CLI when a --genre filter is present and no --lean-verbs
    override is given. Engages only when the filtered `pool` is genuinely
    mixed: at least one card strictly carries a chosen genre AND at least one
    card matches the filter only via the genre-agnostic wildcard. The match
    predicate is strict genre membership (`set(seed.genre) & set(genres)`), so
    genre-agnostic-only cards are excluded from the preferred pile and
    specific-genre cards claim first claim on half the draws (p 0.5, FLOOR
    shrink applied by pull). Returns None for a uniform pool (bare full-bank
    pull with no genre filter, a single-group pool, or an all-agnostic pool),
    preserving the legacy uniform draw.
    """
    if not genres:
        return None
    chosen = set(genres)
    specific = [s for s in pool if set(s["genre"]) & chosen]
    agnostic_only = [
        s for s in pool if not (set(s["genre"]) & chosen) and "genre-agnostic" in s["genre"]
    ]
    if not specific or not agnostic_only:
        return None
    return {"match": lambda s, c=frozenset(chosen): bool(set(s["genre"]) & c)}


def query(conn, genres=None, verb=None, lean_verbs=None):
    """Return matching seeds as canonical dicts.

    A seed matches when no genre filter is given, or its genre array intersects
    the requested genres (OR across the flags). The verb filter is exact;
    `lean_verbs` (a comma-separated string or iterable) additionally narrows
    the listing to seeds whose verb is in the set.
    """
    if genres is not None and not genres:
        genres = None
    lean = _parse_verbs(lean_verbs) if lean_verbs else None
    return [
        s
        for s in _all(conn)
        if _matches(s, genres, verb) and (lean is None or s["verb"] in lean)
    ]


def pull(pool, preference=None, rng=random):
    """Draw a single seed from `pool`, optionally soft-preferencing a subset.

    pool: an iterable of canonical seed dicts, already hard-filtered by the
      caller (via query). This is the drawer's only input; callers never
      pre-split piles.
    preference: None, or {"match": callable(seed)->bool, "weight": float}.
      The matched pile is the subset for which match(seed) is true. A
      two-stage draw runs: with probability effective_p pick uniformly from
      the matched pile, otherwise uniformly from its complement.
    effective_p = w*m / (w*m + c), where m and c are the matched and
      complement pile sizes and w is `weight` (default PREFERENCE_WEIGHT).
      This makes the PER-SEED probability of a matched seed exactly w times
      that of an unmatched one, whatever the piles measure.

      The previous rule — min(p, m / FLOOR), p 0.5 — set the probability of
      the PILE, so the per-seed rate was 0.5/m and inverted or exploded with
      pile size: fiction (m=898, c=563) preferred agnostic seeds 0.64:1, the
      opposite of the intent, while poetry (m=8, c=580) gave eight seeds ~51%
      of all draws (H2-3). Nothing about the numbers said which behaviour was
      wanted; the weight says it.
    rng: any object exposing .random() and .choice(); defaults to the random
      module. Pass random.Random(x) for reproducible draws.
    With no preference, or an empty matched pile, this is a uniform draw over
    pool. Returns a single seed dict.
    """
    pool = list(pool)
    if not pool:
        raise ValueError("pull requires a non-empty pool")
    if preference is None:
        return rng.choice(pool)
    match = preference.get("match")
    if match is None:
        return rng.choice(pool)
    matched = [s for s in pool if match(s)]
    if not matched:
        return rng.choice(pool)
    matched_ids = {s["id"] for s in matched}
    complement = [s for s in pool if s["id"] not in matched_ids]
    weight = preference.get("weight", PREFERENCE_WEIGHT)
    weighted = weight * len(matched)
    effective_p = weighted / (weighted + len(complement))
    if rng.random() < effective_p:
        return rng.choice(matched)
    if not complement:
        return rng.choice(pool)
    return rng.choice(complement)


def export_jsonl(conn, path):
    """Write one canonical seed per line as JSON. Returns number written."""
    seeds = _all(conn)
    with open(path, "w", encoding="utf-8") as f:
        for s in seeds:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    return len(seeds)


def _print_json(seeds):
    print(json.dumps(seeds, ensure_ascii=False, indent=2))


def _load_seeds_file(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, list) else [data]


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="retrieve.py", description="Storage/retrieval for the writer-seed bank."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_db(p):
        p.add_argument(
            "--db", default=str(DB_PATH), help="path to the bank sqlite file (default: %(default)s)"
        )

    p = sub.add_parser("init", help="create the seeds table (idempotent)")
    add_db(p)

    p = sub.add_parser("add", help="upsert seeds from a JSON file (one seed object or an array)")
    p.add_argument("file", help="JSON file with one seed object or an array of seeds")
    add_db(p)

    p = sub.add_parser("query", help="list matching seeds as JSON to stdout")
    p.add_argument("--genre", action="append", help="required genre; repeatable (OR across flags)")
    p.add_argument("--verb", help="exact verb filter")
    p.add_argument("--lean-verbs", help="comma-separated verb set to narrow the listing (soft preference)")
    add_db(p)

    p = sub.add_parser("pull", help="random sample of n distinct matches")
    p.add_argument("--genre", action="append", help="required genre; repeatable (OR across flags)")
    p.add_argument("--verb", help="exact verb filter")
    p.add_argument("--lean-verbs", help="comma-separated verb set to soft-preference (two-stage draw)")
    p.add_argument("--n", type=int, default=1, help="number of distinct seeds to sample (default: %(default)s)")
    add_db(p)

    p = sub.add_parser("export", help="write one seed per line as JSON")
    p.add_argument("--out", default="seeds.jsonl", help="output JSONL path (default: %(default)s)")
    add_db(p)

    args = parser.parse_args(argv)
    conn = init_db(args.db)

    if args.command == "init":
        n = conn.execute("SELECT COUNT(*) FROM seeds").fetchone()[0]
        print(f"table ready at {args.db} ({n} seeds)")
    elif args.command == "add":
        seeds = _load_seeds_file(args.file)
        inserted, replaced = insert_seeds(conn, seeds)
        print(f"added {inserted} new seed(s) to {args.db}")
        if replaced:
            # H5-2: a replacement is a silent LOSS when the two rows are
            # different seeds that happen to share an id. Say so.
            print(f"WARNING: {replaced} existing seed(s) were overwritten by id")
    elif args.command == "query":
        _print_json(query(conn, genres=args.genre, verb=args.verb, lean_verbs=args.lean_verbs))
    elif args.command == "pull":
        matches = query(conn, genres=args.genre, verb=args.verb)
        count = min(max(args.n, 1), len(matches))
        preference = None
        if args.lean_verbs:
            # lean-verbs is the sole preference when present: genre
            # stratification is folded OUT to avoid double-narrowing.
            preference = _lean_preference(args.lean_verbs)
        elif args.genre:
            preference = default_genre_preference(args.genre, matches)
        if preference is None:
            picked = random.sample(matches, count)
        else:
            pool = list(matches)
            picked = []
            for _ in range(count):
                seed = pull(pool, preference)
                picked.append(seed)
                pool = [s for s in pool if s["id"] != seed["id"]]
        _print_json(picked)
    elif args.command == "export":
        n = export_jsonl(conn, args.out)
        print(f"exported {n} seed(s) to {args.out}")
    conn.close()


if __name__ == "__main__":
    main()
