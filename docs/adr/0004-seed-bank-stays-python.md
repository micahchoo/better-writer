# The seed bank stays Python

The seed bank (`seeds/`) is a Python CLI — `retrieve.py` over SQLite and JSONL — built separately. The agent shells out to `python3 seeds/retrieve.py pull --genre <genre>` instead of porting retrieval to TypeScript. Retrieval is not reimplemented; the bank is a sibling, not a dependency to absorb.
