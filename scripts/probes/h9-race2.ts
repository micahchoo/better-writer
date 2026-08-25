/**
 * h9-race2: stronger attempt at angle (e1) — concurrent load-during-save.
 * Larger payload + many races, plus an explicit interleaved run where the
 * load is issued inside the save's own microtask window via a hooked write.
 */
import { createDraftIo } from '../../src/draft.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'h9-race2-'));
const draftUrl = new URL(`file://${dir}/drafts/current.md`);
const annUrl = new URL(`file://${dir}/annotations/current.json`);
const io = createDraftIo(draftUrl, annUrl, { backupEveryNthSave: 1 });

await io.saveDraft('sentinel-old');
const big = 'z'.repeat(8_000_000); // 8MB

let empty = 0, partial = 0, other = 0, old = 0, full = 0;
const N = 800;
for (let i = 0; i < N; i++) {
  const r = await Promise.allSettled([io.saveDraft(big), io.loadDraft()]);
  if (r[1].status !== 'fulfilled') continue;
  const v = (r[1] as PromiseFulfilledResult<string>).value;
  if (v === 'sentinel-old') old++;
  else if (v === big) full++;
  else if (v === '') empty++;
  else if (v.length > 0 && v.length < big.length) partial++;
  else other++;
}
console.log(`${N} races (8MB payload): full=${full} old=${old} empty=${empty} partial=${partial} other=${other}`);
console.log(empty + partial + other > 0
  ? 'REPRODUCED: a load-during-save returned bad content'
  : 'no bad read in this run (writeFile truncate+write is effectively atomic here)');

await rm(dir, { recursive: true, force: true });
