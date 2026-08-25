#!/usr/bin/env python3
"""h5-quotes.py v2: robust verbatim-substring spot-check. Handles ligatures,
smart quotes, markdown formatting, and matches each book against EVERY
available corpus file (md or pdf). READ-ONLY."""
import json
import random
import re
import sqlite3
import subprocess
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SEEDS = ROOT / "seeds"
BOOKS = ROOT / "Books"

BOOK_PATTERNS = {
    "Stein On Writing": ["*Stein On Writing*.md"],
    "Storycraft": ["Storycraft_*.md"],
    "Showing & Telling": ["Laurie Alberts*.md"],
    "Steering the Craft": [
        "Steering the Craft*.pdf",          # clean 2015
        "Ursula K. Le Guin - Steering the Craft*.md",  # 1998 OCR
    ],
}

LIG = {"\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st"}
CURLY = {0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"', 0x201A: "'", 0x201B: "'", 0x201E: '"', 0x201F: '"'}
DASH = {0x2010: "-", 0x2011: "-", 0x2012: "-", 0x2013: "-", 0x2014: "-", 0x2015: "-", 0x2212: "-"}


def norm_text(s):
    s = unicodedata.normalize("NFC", s)
    s = s.translate(LIG)
    s = s.translate(CURLY)
    s = s.translate(DASH)
    # strip common markdown/OCR noise
    s = re.sub(r"[*_#>|`~]", " ", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def load_corpora(book):
    corpora = []
    for pat in BOOK_PATTERNS[book]:
        for p in sorted(BOOKS.glob(pat)):
            if p.suffix == ".pdf":
                r = subprocess.run(["pdftotext", "-layout", str(p), "-"],
                                   capture_output=True, text=True)
                text = r.stdout if r.returncode == 0 else ""
            else:
                text = p.read_text(encoding="utf-8", errors="replace")
            if text.strip():
                corpora.append((p.suffix, p.name, norm_text(text)))
    return corpora


conn = sqlite3.connect(SEEDS / "bank.sqlite")
rows = conn.execute("SELECT id, book, quote FROM seeds").fetchall()
by_book = {}
for sid, book, quote in rows:
    by_book.setdefault(book, []).append((sid, quote))

rng = random.Random(20260824)
corpus_cache = {}
print(f"{'BOOK':<20} {'VERIF':<6} {'MISS':<6} {'TOT':<5} {'PCT':<6}")
grand_v = grand_t = 0
for book, items in sorted(by_book.items()):
    corpora = corpus_cache.setdefault(book, load_corpora(book))
    media = ",".join(sorted({m for m, _, _ in corpora})) if corpora else "NONE"
    sample = rng.sample(items, len(items))
    verified = 0
    real_miss = []
    for sid, quote in sample:
        q = norm_text(quote).strip("\"'")
        if not q:
            real_miss.append((sid, "<empty quote>"))
            continue
        if any(q in c for _, _, c in corpora):
            verified += 1
        else:
            real_miss.append((sid, quote[:110]))
    tot = len(sample)
    grand_v += verified
    grand_t += tot
    print(f"{book:<20} {verified:<6} {len(real_miss):<6} {tot:<5} {verified / tot * 100:<6.0f}  media={media}")
    for sid, q in real_miss:
        print(f"   MISS [{sid}]: {q!r}")

print(f"\nTOTAL: {grand_v}/{grand_t} verified ({grand_v / grand_t * 100:.0f}%)")
