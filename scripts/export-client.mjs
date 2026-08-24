#!/usr/bin/env bun
// Regenerates seeds/client.json from seeds/bank.jsonl.
// Keeps { id, question, genre, verb } per seed, strips provenance (source.*),
// and sorts deterministically by id. Run: bun scripts/export-client.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bankPath = join(root, 'seeds', 'bank.jsonl');
const outPath = join(root, 'seeds', 'client.json');

const lines = readFileSync(bankPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
const seeds = lines.map((line) => {
  const seed = JSON.parse(line);
  return {
    id: seed.id,
    question: seed.question,
    genre: seed.genre,
    verb: seed.verb,
  };
});

seeds.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

writeFileSync(outPath, JSON.stringify(seeds, null, 2) + '\n');
console.log(`wrote ${seeds.length} seeds to ${outPath}`);
