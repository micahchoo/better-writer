# Probes

The evidence behind the findings in [BUGS.md](../../BUGS.md) and
[FIXED.md](../../FIXED.md). Every number those documents quote came out of a
script here. These scripts target the historical interfaces from those findings.
The session refactor changed the coaching request contract. Current behavioral
checks live beside the modules, and `npm run eval:agent` exercises Bonsai.

**Run from the repo root**, never from this directory:

```
npx tsx scripts/probes/probe-s27.ts     # .ts
node   scripts/probes/v-e.mjs           # .mjs — needs a live server, see below
python3 scripts/probes/h5-validate.py   # .py
```

These are measurement scripts, not tests. They print numbers and exit 0; they
assert nothing. The regression tests that *do* assert live beside the code
they cover. A probe's job is to make a claim reproducible and challengeable —
if a fix record says "690 -> 2397", the script that produced both numbers is
here.

Curated from a larger working set: broken, superseded and exploratory scripts
were dropped, as were probes for behaviour that came back clean.

## By finding

| Probe | Backs |
|---|---|
| `probe-s27.ts` | R1 anchor quality over 4000 fiction draws — the 690→2397 and 94.1%→0% numbers |
| `t1.ts` | R2/R3 and H1-1/H1-3: `-ly` and passive/nominalization rates on prose the fixes were not written from |
| `t2.ts` | R4 `isGrounded`, and R6's advice-shaped questions that still pass the gate |
| `t3-grounding.ts` | R4 recall: 1757 seed questions × real sweep windows, prefix rule vs stem rule |
| `probe14.ts` | S1-0 — the three Output Gate attack shapes. Still the guard on that fix |
| `probe13.ts` | Gate predicates in isolation |
| `probe1.ts` | S2-1/S2-2 CRLF offsets and setext headings |
| `probe3.ts` | S2-3/S2-4/S2-5 window statistics |
| `probe4.ts` | S1-1 null-store save |
| `probe6.ts` | S1-2 sweep abort and drain |
| `probe15.ts` | S4-13 sweep planner invariants |
| `probe16.ts` | Annotation reconciliation |
| `probe17.ts` | S4-11 decoration builder with corrupt input |
| `probe8.mjs` | S3-5 boundary over raw sockets (needs a live server) |
| `h1-probe.ts`, `h1-probe2.ts` | H1-1..H1-7 as first measured |
| `h2-gate.ts`, `h2-confirm.ts` | H2-1/H2-2/H2-4 |
| `h2-pickseed-groups.ts` | H2-3 seed-draw distribution |
| `h3-anchor-final.ts` | H3-1 U+0130 offset drift |
| `h3-savecoord-dispose.ts` | H3-2 post-unmount save |
| `h4-boundary.mjs`, `h4-payload.mjs`, `h4-final.mjs` | H4-1/H4-2/H4-3 (need a live server) |
| `h5-validate.py`, `h5-schema.py` | H5-1/H5-2/H5-4 seed-bank validation |
| `h5-quotes-full.py` | H5-3 — whole-bank quote verification, ~10 minutes. The 194/1759 figure |
| `h6-*.ts` | H6-1/H6-2/H6-3 |
| `h7-fuzz.ts`, `h7-request.ts` | H7-1/H7-2/H7-3 |
| `h8-openstream-timeout.ts` | H8-1 |
| `h9-multi.ts`, `h9-plan.ts`, `h9-race2.ts` | H9-1/H9-2/H9-3 (`h9-shared.ts` is a helper) |
| `v-a.ts`, `v-a2.ts` | H3-1, H1-4, H1-6 verified before and after |
| `v-b.ts`, `v-b2.ts` | H1-1/2/3/7 and H1-5 |
| `v-c.ts`, `v-c2.ts` | H2-1/H2-2, and H2-3's per-seed ratio at three pile shapes |
| `v-d.ts` | H3-2 |
| `v-e.mjs` | H4-1/H4-2 over raw sockets (needs a live server) |
| `orphan-test.mjs` | S1-3 — the STT worker must die with the server (needs a live server and the Parakeet model) |
| `v-h91.ts`, `v-h92.ts`, `v-h93.ts` | H9-1/H9-2/H9-3 |

## Probes that need a live server

`probe8.mjs`, `v-e.mjs`, `h4-*.mjs`, `orphan-test.mjs`. Port 4517 is usually taken, so start one
on a free port and point the probe at it:

```
BW_PORT=4771 npx tsx src/server.ts
```

Use a raw socket for anything Host-related — node's `fetch` rewrites the Host
header and normalizes `../` in paths, which silently makes boundary probes
inconclusive. That is why those three are `.mjs` using `net.connect` rather
than `fetch`.

## Reproducing a before/after

Several records quote a number from before a fix. Get it by checking the old
file out beside the probe:

```
git show f37a156:web/anchor.ts > /tmp/old-anchor.ts
cp web/anchor.ts /tmp/new-anchor.ts && cp /tmp/old-anchor.ts web/anchor.ts
npx tsx scripts/probes/probe-s27.ts
cp /tmp/new-anchor.ts web/anchor.ts
```
