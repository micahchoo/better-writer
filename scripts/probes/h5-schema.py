#!/usr/bin/env python3
"""h5-schema.py: mechanically validate seeds/*.json chapter files + staging/
rescan-*.json against schema.json's constraints, and sample-check staging
rescan ids landed in the bank. READ-ONLY."""
import json
import re
import sqlite3
import sys
from pathlib import Path

SEEDS = Path(__file__).resolve().parent.parent.parent / "seeds"
ID_RE = re.compile(r"^[a-z0-9-]+$")
VERBS = {"rewrite", "elaborate", "elucidate", "cut", "transition", "concept-form", "rephrase"}
GENRES = {"fiction", "creative-nonfiction", "memoir", "essay", "poetry", "genre-agnostic"}
SRC_KEYS = {"book", "author", "chapter", "quote"}

problems = []


def validate_one(s, fname, idx):
    errs = []
    if not isinstance(s, dict):
        return [f"{fname}[{idx}]: not an object ({type(s).__name__})"]
    for k in ("id", "question", "verb", "genre", "source"):
        if k not in s:
            errs.append(f"{fname}[{idx}] id={s.get('id','?')}: missing required key {k!r}")
    extra = set(s) - {"id", "question", "verb", "genre", "source"}
    if extra:
        errs.append(f"{fname}[{idx}] id={s.get('id','?')}: extra top-level keys {sorted(extra)}")
    if "id" in s:
        if not isinstance(s["id"], str) or not ID_RE.match(s["id"]):
            errs.append(f"{fname}[{idx}]: id {s['id']!r} violates ^[a-z0-9-]+$")
    if "question" in s and (not isinstance(s["question"], str) or not s["question"]):
        errs.append(f"{fname}[{idx}] id={s.get('id','?')}: question empty or non-string")
    if "verb" in s and (not isinstance(s["verb"], str) or s["verb"] not in VERBS):
        errs.append(f"{fname}[{idx}] id={s.get('id','?')}: verb {s.get('verb')!r} not in enum")
    if "genre" in s:
        if not isinstance(s["genre"], list) or not s["genre"]:
            errs.append(f"{fname}[{idx}] id={s.get('id','?')}: genre not non-empty list")
        else:
            for g in s["genre"]:
                if not isinstance(g, str) or g not in GENRES:
                    errs.append(f"{fname}[{idx}] id={s.get('id','?')}: genre {g!r} not in enum")
    src = s.get("source")
    if isinstance(src, dict):
        for k in SRC_KEYS:
            if k not in src:
                errs.append(f"{fname}[{idx}] id={s.get('id','?')}: source missing {k!r}")
        extra = set(src) - SRC_KEYS
        if extra:
            errs.append(f"{fname}[{idx}] id={s.get('id','?')}: source extra keys {sorted(extra)}")
        if "quote" in src and (not isinstance(src["quote"], str) or not src["quote"]):
            errs.append(f"{fname}[{idx}] id={s.get('id','?')}: quote empty")
    return errs


# H5-4: the seeds/ directory contract is explicit now. Use retrieve's own
# extraction_files() instead of a naive glob, which used to sweep up
# vocab.json (constants) and client.json (a generated export of the very
# files it was being compared against) and report both as schema problems.
sys.path.insert(0, str(SEEDS))
import retrieve  # noqa: E402

targets = retrieve.extraction_files(SEEDS) + sorted((SEEDS / "staging").glob("rescan-*.json"))

seen_ids = {}
for p in targets:
    try:
        data = json.load(open(p, encoding="utf-8"))
    except Exception as e:
        problems.append(f"{p.name}: UNPARSEABLE {e}")
        continue
    if not isinstance(data, list):
        problems.append(f"{p.name}: top-level not a list")
        continue
    for idx, s in enumerate(data):
        errs = validate_one(s, p.name, idx)
        problems.extend(errs)
        if isinstance(s, dict) and "id" in s:
            if s["id"] in seen_ids:
                problems.append(f"{p.name}: duplicate id {s['id']!r} (also in {seen_ids[s['id']]})")
            seen_ids[s["id"]] = p.name

print(f"chapter/staging files validated: {len(targets)}")
dup_global = {k for k, v in seen_ids.items() if list(targets for _ in [0]).count(0) and list(seen_ids).count(k) > 1}
print(f"distinct ids across files: {len(seen_ids)}")

# ---- staging rescan landing check
conn = sqlite3.connect(SEEDS / "bank.sqlite")
bank_ids = {r[0] for r in conn.execute("SELECT id FROM seeds")}
staging_files = sorted((SEEDS / "staging").glob("rescan-*.json"))
print(f"\nstaging rescan files: {len(staging_files)}")
total_staged = missing = 0
for sf in staging_files:
    data = json.load(open(sf, encoding="utf-8"))
    ids = [s["id"] for s in data]
    total_staged += len(ids)
    miss = [i for i in ids if i not in bank_ids]
    missing += len(miss)
    print(f"  {sf.name}: {len(ids)} seeds, {len(miss)} NOT in bank {miss[:5]}")
print(f"staging total {total_staged}, missing from bank {missing}")

# ---- all bank ids present in some chapter/staging file? (reverse: orphan bank seeds)
file_ids = set(seen_ids)
bank_only = bank_ids - file_ids
print(f"\nbank ids NOT in any chapter/staging file: {len(bank_only)} {sorted(bank_only)[:10]}")

print("\n" + ("FAIL " + str(len(problems)) + " schema problems" if problems else "schema ALL PASS"))
for pr in problems[:60]:
    print("   ", pr)
sys.exit(1 if problems else 0)
