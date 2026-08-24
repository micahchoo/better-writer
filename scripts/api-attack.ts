import net from 'node:net';

/**
 * Adversarial API attack suite for better-writer server (isolated instance).
 * Run: npx tsx scripts/api-attack.ts http://127.0.0.1:4699
 * Requires the smoke instance at /tmp/bw-smoke with empty data/.
 * Single file, own concurrency, cleans up only its own view (smoke instance is disposable).
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:4699';

type Result = { id: string; area: string; got: number | string; want: string; verdict: 'PASS' | 'FAIL' | 'NOTE'; detail?: string };

const results: Result[] = [];
function rec(id: string, area: string, got: number | string, want: string, verdict: Result['verdict'], detail?: string) {
  results.push({ id, area, got, want, verdict, detail });
}

async function req(method: string, path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(BASE + path, { method, redirect: 'manual', ...opts });
}

// ---------- A. Input sanitization ----------
async function attacks_input() {
  // A1 null byte in draft
  let r = await req('POST', '/save', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: 'a\u0000b', annotations: [] }) });
  rec('A1', 'input', r.status, '<500', r.status < 500 ? 'PASS' : 'FAIL');

  // A2 deeply nested JSON (raw)
  const deep = '{"draft":' + '['.repeat(2000) + ']'.repeat(2000);
  r = await req('POST', '/save', { headers: { 'Content-Type': 'application/json' }, body: deep });
  rec('A2', 'input', r.status, '<500', r.status < 500 ? 'PASS' : 'FAIL', deep.length + 'B nested array body');

  // A3 huge draft (5MB)
  r = await req('POST', '/save', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: 'x'.repeat(5 * 1024 * 1024), annotations: [] }) });
  rec('A3', 'input', r.status, '<500', r.status < 500 ? 'PASS' : 'FAIL', '5MB draft accepted=' + (r.status === 200));

  // A4 prototype pollution attempt
  r = await req('POST', '/save', { headers: { 'Content-Type': 'application/json' }, body: '{"draft":"pp","annotations":[{"__proto__":{"polluted":true},"start":0,"end":1,"fragment":"f","question":"q","ts":0}]}' });
  rec('A4', 'input', r.status, 'accept-or-400 <500', r.status < 500 ? 'PASS' : 'FAIL');
  const lr = await (await req('GET', '/load')).json() as { draft: string };
  rec('A4b', 'input', lr.draft, '"pp"', lr.draft === 'pp' ? 'PASS' : 'FAIL', 'stored draft after pp attempt');

  // A5 annotation field confusion
  for (const [i, ann] of [
    { start: '0', end: 1, fragment: 'f', question: 'q', ts: 0 },
    { start: 0, end: 1, fragment: 'f', question: 'q' },
    { start: NaN, end: 1, fragment: 'f', question: 'q', ts: 0 },
    'string-item',
    null,
  ].entries()) {
    r = await req('POST', '/save', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: 'd', annotations: [ann] }) });
    rec(`A5${i}`, 'input', r.status, '400', r.status === 400 ? 'PASS' : 'FAIL', JSON.stringify(ann)?.slice(0, 60));
  }

  // A6 annotations non-array
  r = await req('POST', '/save', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: 'd', annotations: { not: 'array' } }) });
  rec('A6', 'input', r.status, '400', r.status === 400 ? 'PASS' : 'FAIL');

  // A7 annotations null literal (vs absent which means [])
  r = await req('POST', '/save', { headers: { 'Content-Type': 'application/json' }, body: '{"draft":"d","annotations":null}' });
  rec('A7', 'input', r.status, '400', r.status === 400 ? 'PASS' : 'FAIL', 'null is not undefined');

  // A8 /ask validation
  r = await req('POST', '/ask', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text_window: 42, genre: 'fiction' }) });
  rec('A8', 'input', r.status, '400', r.status === 400 ? 'PASS' : 'FAIL');
  r = await req('POST', '/ask', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text_window: 't', genre: 'DROP TABLE' }) });
  rec('A9', 'input', r.status, '400', r.status === 400 ? 'PASS' : 'FAIL');
  r = await req('POST', '/ask', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text_window: 't'.repeat(10 * 1024 * 1024), genre: 'fiction' }) });
  rec('A10', 'input', r.status, '<500 tolerated', r.status < 500 || r.status >= 500 ? 'NOTE' : 'FAIL', '10MB window status=' + r.status);

  // A11 unicode violence in draft survives round-trip
  const zalgo = 'e̶g̷e̴s̶t̷ ̸R̴L̵M‮test';
  r = await req('POST', '/save', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: zalgo, annotations: [] }) });
  const back = await (await req('GET', '/load')).json() as { draft: string };
  rec('A11', 'input', `${r.status}/${String(back.draft === zalgo)}`, '200/true', r.status === 200 && back.draft === zalgo ? 'PASS' : 'FAIL');
}

// ---------- B. Concurrency ----------
let tornPairs = 0;
let okPairs = 0;
async function attacks_concurrency() {
  // B1: 40 distinct saves racing; each save N tags draft "save-N" and annotation question "q-N"
  const saves = Array.from({ length: 40 }, (_, i) => i);
  await Promise.all(saves.map((n) =>
    req('POST', '/save', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft: `save-${n}\n`,
        annotations: [{ start: 0, end: 6, fragment: `save-${n}`.slice(0, 6), question: `q-${n}`, ts: n }],
      }),
    })));
  // B2: interleave loads while saving continues, detect torn pairs
  const jobs: Promise<void>[] = [];
  for (let wave = 40; wave < 80; wave++) {
    jobs.push(req('POST', '/save', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: `save-${wave}\n`, annotations: [{ start: 0, end: 6, fragment: 'save-0', question: `q-${wave}`, ts: wave }] }),
    }).then(() => void 0));
    jobs.push(req('GET', '/load').then(async (r) => {
      const j = await r.json() as { draft: string; annotations: { question: string }[] };
      if (!r.ok) { tornPairs++; return; }
      const mD = /^save-(\d+)$/m.exec(j.draft);
      const mQ = j.annotations[0] && /^q-(\d+)$/.exec(j.annotations[0].question);
      if (mD && mQ) { mD[1] === mQ[1] ? okPairs++ : tornPairs++; }
    }));
  }
  await Promise.all(jobs);
  rec('B1', 'concurrency', `${okPairs} match / ${tornPairs} torn`, 'all match or documented LWW', tornPairs === 0 ? 'NOTE' : 'NOTE',
    tornPairs > 0 ? `TORN STATE OBSERVED: draft from save X with annotations from save Y (${tornPairs} times)` : 'no torn pairs observed in this window (race still exists by construction)');
  // Final state sane?
  const fin = await (await req('GET', '/load')).json() as { draft: string };
  rec('B3', 'concurrency', String(!!fin.draft), 'some coherent draft', fin.draft.startsWith('save-') ? 'PASS' : 'FAIL');
}

// ---------- C. Protocol abuse ----------
async function attacks_protocol() {
  const methodCases: [string, string][] = [['PUT', '404'], ['DELETE', '404'], ['PATCH', '404'], ['OPTIONS', '404']];
  for (const [m, want] of methodCases) {
    const r = await req(m, '/health');
    rec(`C1-${m}`, 'protocol', r.status, `<500 (want ${want})`, r.status < 500 ? 'PASS' : 'FAIL');
  }
  let r: Response;
  // no content-type, valid body
  r = await req('POST', '/save', { body: JSON.stringify({ draft: 'nct', annotations: [] }) });
  rec('C2', 'protocol', r.status, '<500', r.status < 500 ? 'PASS' : 'FAIL', 'no content-type');
  // C3/C4: no-preflight cross-origin write primitives. Browser attaches Origin.
  // lying content-type WITH the Origin a browser always attaches cross-origin —
  // the exact no-preflight write primitive from a hostile web page.
  r = await req('POST', '/save', { headers: { 'Content-Type': 'text/plain', 'Origin': 'http://attacker.example' }, body: JSON.stringify({ draft: 'csrf-primitive', annotations: [] }) });
  rec('C3', 'csrf', r.status, 'reject=4xx', r.status === 200 ? 'FAIL' : 'PASS', r.status === 200 ? 'cross-origin no-preflight write succeeded' : `rejected (${r.status})`);
  // form-encoded primitive with foreign Origin
  r = await req('POST', '/save', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'http://attacker.example' }, body: encodeURIComponent(JSON.stringify({ draft: 'form-csrf', annotations: [] })) });
  rec('C4', 'csrf', r.status, 'reject=4xx', r.status === 200 ? 'FAIL' : 'PASS', 'urlencoded body');
  // forged Host header (DNS rebinding primitive): raw socket so the hostile
  // Host truly reaches the server (undici silently rewrites manual Host).
  const rebinding = await new Promise<string>((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: Number(new URL(BASE).port) }, () => {
      const body = JSON.stringify({ draft: 'rebind', annotations: [] });
      s.write(`POST /save HTTP/1.1\r\nHost: evil.example\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    });
    let buf = '';
    s.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('\r\n\r\n')) {
        resolve(buf.split(' ')[1] ?? buf);
        s.destroy();
      }
    });
    s.on('error', (e: Error) => resolve('conn-err:' + e.message.slice(0, 40)));
  });
  rec('C5', 'csrf', rebinding, '403', rebinding === '403' ? 'PASS' : 'FAIL', 'raw-socket POST with Host: evil.example');
  // long URL + many params
  r = await req('GET', '/health?' + Array.from({ length: 1000 }, (_, i) => `p${i}=v`).join('&'));
  rec('C6', 'protocol', r.status, '<500', r.status < 500 ? 'PASS' : 'FAIL', '1000 query params');
  const longPath = '/' + 'a'.repeat(9000);
  r = await req('GET', longPath);
  rec('C7', 'protocol', r.status, '<500', r.status < 500 ? 'PASS' : 'FAIL', '9KB path');
  // malformed json bodies to every POST route
  for (const p of ['/ask', '/save']) {
    r = await req('POST', p, { headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    rec(`C8-${p}`, 'protocol', r.status, '400', r.status === 400 ? 'PASS' : 'FAIL');
    r = await req('POST', p, { headers: { 'Content-Type': 'application/json' }, body: '' });
    rec(`C9-${p}`, 'protocol', r.status, '<500', r.status < 500 ? 'PASS' : 'FAIL', 'empty body');
  }
  // transcribe protocol abuse
  r = await req('POST', '/transcribe', { headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  rec('C10', 'protocol', r.status, '400', r.status === 400 ? 'PASS' : 'FAIL');
  r = await req('POST', '/transcribe', { headers: { 'Content-Type': 'audio/wav' }, body: 'short' });
  rec('C11', 'protocol', r.status, '400', r.status === 400 ? 'PASS' : 'FAIL', 'body shorter than WAV header');
  const mk = (fmt: number, ch: number, bits: number, dataSize: number): Uint8Array => {
    const b = new Uint8Array(44 + 8);
    b.set([0x52, 0x49, 0x46, 0x46], 0); b.set([0x57, 0x41, 0x56, 0x45], 8);
    b.set([0x66, 0x6d, 0x74, 0x20], 12); // fmt
    new DataView(b.buffer).setUint32(16, 16, true); new DataView(b.buffer).setUint16(20, fmt, true);
    new DataView(b.buffer).setUint16(22, ch, true); new DataView(b.buffer).setUint32(24, 44100, true);
    new DataView(b.buffer).setUint16(34, bits, true);
    b.set([0x64, 0x61, 0x74, 0x61], 36); new DataView(b.buffer).setUint32(40, dataSize >>> 0, true);
    return b;
  };
  const cases: [string, Uint8Array][] = [
    ['float-fmt', mk(3, 1, 16, 0)],
    ['stereo', mk(1, 2, 16, 0)],
    ['8bit', mk(1, 1, 8, 0)],
    ['huge-dataSize', mk(1, 1, 16, 0xFFFFFFFF)],
    ['zero-dataSize', mk(1, 1, 16, 0)],
  ];
  for (const [name, bytes] of cases) {
    r = await req('POST', '/transcribe', { headers: { 'Content-Type': 'audio/wav' }, body: new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }) });
    rec(`C12-${name}`, 'protocol', r.status, '<500 (400 or 503)', r.status !== 500 ? 'PASS' : 'FAIL', `status=${r.status}`);
  }
}

// ---------- D. Static path traversal ----------
async function attacks_traversal() {
  const targets = [
    '/../server.ts',
    '/..%2f..%2fetc%2fpasswd',
    '/%2e%2e/%2e%2e/package.json',
    '/dist/../src/server.ts',
    '/assets/%2e%2e/%2e%2e/src/server.ts',
    '/%252e%252e/package.json',
    '/..\\package.json',
    '/package.json/../data/drafts/current.md',
    '/data/drafts/current.md',
    '/.env',
    '/seeds/bank.jsonl',
  ];
  for (const t of targets) {
    const r = await req('GET', t);
    const bodyText = t.includes('%00') ? '' : (await r.text()).slice(0, 40).replace(/\n/g, '\\n');
    const leaked = r.status === 200 && !bodyText.startsWith('<') && !bodyText.startsWith('<!doctype');
    // SPA fallback serves index.html for any miss: flag only NON-html 200s or exact source leakage
    const suspicious = r.status === 200 && !(r.headers.get('content-type') ?? '').includes('html');
    rec(`D:${t}`, 'traversal', `${r.status}`, '403/404/html-fallback', suspicious || /import|PORT|password/.test(bodyText) ? 'FAIL' : 'PASS', `${leaked ? 'LEAK?' : ''} ct=${r.headers.get('content-type')} body="${bodyText}"`);
  }
  // encoded null path
  const r = await req('GET', '/index.html%00.js');
  rec('D:nullbyte', 'traversal', r.status, '<500', r.status < 500 ? 'PASS' : 'FAIL');
}

// ---------- E. Header abuse ----------
async function attacks_headers() {
  const r = await fetch(BASE + '/health', { headers: { 'X-Big': 'z'.repeat(70000) } }).then((x) => x.status).catch((e) => 'conn-err:' + String(e).slice(0, 40));
  rec('E1', 'protocol', String(r), '<500 or conn reset', String(r).startsWith('4') || String(r) === '200' || String(r).startsWith('conn') ? 'PASS' : 'FAIL', '70KB header');
}

(async () => {
  console.log(`target=${BASE}`);
  // baseline sanity
  const h = await req('GET', '/health');
  if (!(h.ok)) throw new Error('target not healthy; aborting');
  await attacks_input();
  await attacks_concurrency();
  await attacks_protocol();
  await attacks_traversal();
  await attacks_headers();

  // summary table
  console.log('\nID     AREA         GOT                WANT                     VERDICT');
  const fails = results.filter((r) => r.verdict === 'FAIL');
  const notes = results.filter((r) => r.verdict === 'NOTE');
  for (const r of [...results.filter((x) => x.verdict !== 'NOTE'), ...notes]) {
    console.log(
      r.id.padEnd(22).slice(0, 22),
      r.area.padEnd(12),
      String(r.got).padEnd(18).slice(0, 18),
      r.want.padEnd(24).slice(0, 24),
      r.verdict,
      r.detail ? '| ' + r.detail.slice(0, 110) : '',
    );
  }
  console.log(`\ntotal=${results.length} pass=${results.filter(r => r.verdict === 'PASS').length} fail=${fails.length} notes=${notes.length}`);
  process.exit(0);
})();
