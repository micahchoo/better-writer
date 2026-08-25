// h4-payload.mjs — payload abuse probes against isolated 127.0.0.1:4771.
import http from 'node:http';
import fs from 'node:fs';

const HOST = '127.0.0.1';
const PORT = 4771;

function post(path, body, headers = {}) {
  return new Promise((resolve) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: HOST, port: PORT, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let out = '';
        res.on('data', (d) => (out += d));
        res.on('end', () => resolve({ status: res.statusCode, body: out.slice(0, 300) }));
      },
    );
    req.on('error', (e) => resolve({ status: 'ERR', body: e.message }));
    req.end(data);
  });
}

// 1. 50MB draft
const big = 'A'.repeat(50 * 1024 * 1024);
let r = await post('/save', { draft: big, annotations: [] });
console.log(`50MB draft  -> ${r.status} ${JSON.stringify(r.body)}`);

// 2. JSON bomb: deep nesting
const deep = '['.repeat(200000) + ']'.repeat(200000);
r = await post('/save', deep, { 'content-type': 'application/json' });
console.log(`deep-nest 200k -> ${r.status} ${JSON.stringify(r.body)}`);

// 3. array body
r = await post('/save', [1, 2, 3]);
console.log(`array body   -> ${r.status} ${JSON.stringify(r.body)}`);

// 4. wrong types
for (const [label, body] of [
  ['draft:number', { draft: 123, annotations: [] }],
  ['draft:null', { draft: null, annotations: [] }],
  ['draft:object', { draft: {}, annotations: [] }],
  ['annotations:object', { draft: 'x', annotations: { a: 1 } }],
  ['annotations:string', { draft: 'x', annotations: 'nope' }],
  ['annotation.start:NaN-string', { draft: 'x', annotations: [{ start: '5', end: 6, fragment: 'f', question: 'q', ts: 1 }] }],
  ['annotation.start:negative', { draft: 'x', annotations: [{ start: -1, end: 6, fragment: 'f', question: 'q', ts: 1 }] }],
  ['annotation.end<=start', { draft: 'x', annotations: [{ start: 6, end: 6, fragment: 'f', question: 'q', ts: 1 }] }],
  ['annotation.source:evil', { draft: 'x', annotations: [{ start: 0, end: 1, fragment: 'f', question: 'q', ts: 1, source: 'evil' }] }],
  ['annotation.ts:null', { draft: 'x', annotations: [{ start: 0, end: 1, fragment: 'f', question: 'q', ts: null }] }],
  ['draft missing', { annotations: [] }],
  ['empty object', {}],
  ['null literal', null],
]) {
  r = await post('/save', body);
  console.log(`${label.padEnd(30)} -> ${r.status} ${JSON.stringify(r.body)}`);
}

// 5. /ask with a non-string text_window
r = await post('/ask', { text_window: 42, genre: 'fiction' });
console.log(`ask text_window:number -> ${r.status} ${JSON.stringify(r.body)}`);
r = await post('/ask', { text_window: 'hello', genre: 'not-a-genre' });
console.log(`ask genre:invalid       -> ${r.status} ${JSON.stringify(r.body)}`);

// What landed on disk
const drafts = fs.readdirSync('/tmp/bw-h4/data/drafts');
const anns = fs.readdirSync('/tmp/bw-h4/data/annotations');
console.log('\ndata/drafts:', drafts, 'sizes:', drafts.map((f) => fs.statSync(`/tmp/bw-h4/data/drafts/${f}`).size));
console.log('data/annotations:', anns, 'sizes:', anns.map((f) => fs.statSync(`/tmp/bw-h4/data/annotations/${f}`).size));
const cur = fs.readFileSync('/tmp/bw-h4/data/drafts/current.md', 'utf8');
console.log('current.md len:', cur.length, 'all-A?', /^A+$/.test(cur));
