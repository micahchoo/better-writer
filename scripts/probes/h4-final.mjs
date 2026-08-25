import http from 'node:http';
import fs from 'node:fs';
function req(path, method = 'POST', body, headers = {}) {
  return new Promise((res) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: 4771, path, method, headers }, (resp) => { let o = ''; resp.on('data', (d) => (o += d)); resp.on('end', () => res({ s: resp.statusCode, b: o.slice(0, 120) })); });
    r.on('error', (e) => res({ s: 'ERR', b: e.message })); r.end(data);
  });
}
console.log('save draft only (no annotations) ->', JSON.stringify(await req('/save', 'POST', { draft: 'draft-only-no-anns' })));
console.log('save text/plain JSON            ->', JSON.stringify(await req('/save', 'POST', '{"draft":"textplain-body","annotations":[]}', { 'content-type': 'text/plain' })));
const load = await new Promise((res) => { http.get({ host: '127.0.0.1', port: 4771, path: '/load' }, (r) => { let o = ''; r.on('data', (d) => (o += d)); r.on('end', () => res(o)); }); });
console.log('/load ->', load.slice(0, 200));
console.log('drafts dir:', fs.readdirSync('/tmp/bw-h4/data/drafts'));
console.log('current.md:', JSON.stringify(fs.readFileSync('/tmp/bw-h4/data/drafts/current.md', 'utf8').slice(0, 60)));
console.log('backup    :', JSON.stringify(fs.readFileSync('/tmp/bw-h4/data/drafts/current.md.backup', 'utf8').slice(0, 60)));
console.log('annotations:', fs.readFileSync('/tmp/bw-h4/data/annotations/current.json', 'utf8'));
