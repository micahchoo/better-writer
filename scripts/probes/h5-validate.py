#!/usr/bin/env python3
"""h5-validate.py: hostile-insert validation on a COPY of bank.sqlite.
The real seeds/bank.sqlite is never touched."""
import copy
import json
import shutil
import sqlite3
import sys
import tempfile
import unicodedata
from pathlib import Path

SEEDS = Path(__file__).resolve().parent.parent.parent / "seeds"
H5 = Path(__file__).resolve().parent
sys.path.insert(0, str(SEEDS))
import retrieve  # noqa: E402

TMP = Path(tempfile.mkdtemp(prefix="h5-"))
WORK = TMP / "h5-tmp.db"
shutil.copy(SEEDS / "bank.sqlite", WORK)
print(f"copy db: {WORK}")
conn = retrieve.init_db(WORK)
before = retrieve._all(conn)
print(f"baseline count on copy: {len(before)}")

BASE = {
    "id": "h5-hostile-probe",
    "question": "Rewrite the sentence to cut the dead verb.",
    "verb": "rewrite",
    "genre": ["fiction"],
    "source": {
        "book": "Probe Book",
        "author": "Probe Author",
        "chapter": "ch.1",
        "quote": "A verbatim probe quote.",
    },
}

results = []


def probe(name, mutate, expect_raise=None):
    """Try inserting a mutated seed. expect_raise: set of errors we'd accept as
    'clean rejection'; None means 'document whatever happens'."""
    c = copy.deepcopy(BASE)
    mutate(c)
    try:
        n = retrieve.insert_seeds(conn, c)
    except Exception as e:
        results.append((name, f"RAISED {type(e).__name__}: {e}"))
        return
    # check whether it actually landed
    cur = conn.execute("SELECT question, verb, genre FROM seeds WHERE id=?", (c["id"],)).fetchone()
    landed = cur is not None
    results.append((name, f"accepted count={n}, landed={landed}, stored_verb={cur[1] if cur else '-'}"))


def fresh_id(seed):
    # give each probe a unique id so later probes don't collide/overwrite prior probes
    seed["id"] = seed["id"] + "-" + str(len(results))


# 1. unknown verb
def m1(s):
    fresh_id(s)
    s["verb"] = "teleport"
probe("unknown-verb", m1)

# 2. unknown genre value
def m2(s):
    fresh_id(s)
    s["genre"] = ["horror"]
probe("unknown-genre", m2)

# 3. missing quote
def m3(s):
    fresh_id(s)
    del s["source"]["quote"]
probe("missing-quote", m3)

# 4. empty question
def m4(s):
    fresh_id(s)
    s["question"] = ""
probe("empty-question", m4)

# 5. 10KB question
def m5(s):
    fresh_id(s)
    s["question"] = "x" * 10000
probe("10KB-question", m5)

# 6. duplicate id (real existing id) -> overwrite or dup?
existing_id = before[0]["id"]
def m6(s):
    s["id"] = existing_id
    s["question"] = "OVERWRITTEN-H5-PROBE"
probe(f"duplicate-id-overwrite (existing {existing_id})", m6)

# 7. NFC vs NFD variant of an existing id
def m7(s):
    fresh_id(s)
    s["id"] = existing_id  # may itself be NFC; build NFD variant of it
    nfd = unicodedata.normalize("NFD", existing_id)
    if nfd == existing_id:
        nfd = unicodedata.normalize("NFD", "cafe-au-lait-01")  # ascii unaffected
    s["id"] = nfd
    s["question"] = "NFD-VARIANT-PROBE"
probe(f"unicode-NFD-variant-of-existing-id (existing={existing_id!r})", m7)

print("\n--- probe results ---")
for name, res in results:
    print(f"{name}: {res}")

# after
after = retrieve._all(conn)
print(f"\nafter count on copy: {len(after)}")

# exit codes of the add CLI on hostile inputs
def cli_add(path):
    from subprocess import run
    r = run([sys.executable, str(SEEDS / "retrieve.py"), "add", str(path), "--db", str(WORK)],
            capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


# hostile A: unknown verb via CLI
bad_verb = TMP / "bad-verb.json"
bad_verb.write_text(json.dumps({**BASE, "id": "h5-cli-badverb", "verb": "teleport"}))
rc, out = cli_add(bad_verb)
print(f"\nCLI add unknown-verb: rc={rc} out={out!r}")
print("  -> silent acceptance (exit 0)" if rc == 0 else "  -> rejected")

# hostile B: missing quote via CLI
bad_q = TMP / "bad-quote.json"
bq = copy.deepcopy(BASE); bq["id"] = "h5-cli-badquote"; del bq["source"]["quote"]
bad_q.write_text(json.dumps(bq))
rc, out = cli_add(bad_q)
print(f"CLI add missing-quote: rc={rc} out={out!r}")
print("  -> rejected" if rc != 0 else "  -> silent acceptance")

conn.close()
