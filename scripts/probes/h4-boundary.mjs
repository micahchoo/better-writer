// h4-boundary.mjs — raw-socket Host/Origin boundary probes against the isolated
// instance at 127.0.0.1:4771. Raw sockets (net.createConnection) are used so the
// Host header is written by hand exactly as the wire carries it — node's fetch
// silently overrides a manual Host header, so it cannot probe DNS-rebinding.
import net from 'node:net';

const PORT = 4771;
const HOST = '127.0.0.1';

function rawRequest({ hostLine = null, originLine = null, method = 'GET', path = '/health', extra = '' } = {}) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: HOST, port: PORT }, () => {
      let req = `${method} ${path} HTTP/1.1\r\n`;
      if (hostLine !== null) req += `Host: ${hostLine}\r\n`;
      req += 'Connection: close\r\n';
      if (originLine !== null) req += `Origin: ${originLine}\r\n`;
      req += extra + '\r\n';
      sock.write(req);
    });
    let data = '';
    sock.on('data', (d) => (data += d.toString()));
    sock.on('end', () => resolve(data));
    sock.on('error', (e) => resolve(`ERROR: ${e.message}`));
    sock.setTimeout(5000, () => { sock.destroy(); resolve(data + ' [TIMEOUT]'); });
  });
}

// HTTP/1.0 has no Host header at all.
function rawRequestHttp10({ originLine = null, method = 'GET', path = '/health' } = {}) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: HOST, port: PORT }, () => {
      let req = `${method} ${path} HTTP/1.0\r\n`;
      if (originLine !== null) req += `Origin: ${originLine}\r\n`;
      req += 'Connection: close\r\n\r\n';
      sock.write(req);
    });
    let data = '';
    sock.on('data', (d) => (data += d.toString()));
    sock.on('end', () => resolve(data));
    sock.on('error', (e) => resolve(`ERROR: ${e.message}`));
  });
}

function status(resp) {
  const m = resp.match(/^HTTP\/1\.[01] (\d+)/);
  return m ? m[1] : `NO-STATUS(${resp.slice(0, 40)})`;
}

const cases = [
  ['Host: evil.example.com (foreign)', { hostLine: 'evil.example.com' }],
  ['Host: 127.0.0.1 (legit)', { hostLine: '127.0.0.1' }],
  ['Host: 127.0.0.1:4771 (legit+port)', { hostLine: '127.0.0.1:4771' }],
  ['Host: 127.0.0.1.evil.com (trusted suffix)', { hostLine: '127.0.0.1.evil.com' }],
  ['Host: [::1]evil.com  (bracket-suffix BUG?)', { hostLine: '[::1]evil.com' }],
  ['Host: [::1]:4771 (legit ipv6+port)', { hostLine: '[::1]:4771' }],
  ['Host: [::1]:evil (bracket + nondigit port)', { hostLine: '[::1]:evil' }],
  ['Host: LOCALHOST (uppercase)', { hostLine: 'LOCALHOST' }],
  ['Host: 127.0.0.1:evil (nondigit port suffix)', { hostLine: '127.0.0.1:evil' }],
  ['Host: localhost.:4771 (trailing dot)', { hostLine: 'localhost.:4771' }],
  ['Host: 127.0.0.1:999999 (port>65535)', { hostLine: '127.0.0.1:999999' }],
  ['Host: 127.0.0.1.evil (suffix, no port)', { hostLine: '127.0.0.1.evil' }],
  ['NO Host (HTTP/1.1)', { hostLine: null }],
  ['NO Host + Origin:http://evil.com', { hostLine: null, originLine: 'http://evil.com' }],
  ['NO Host + Origin:http://127.0.0.1:4771', { hostLine: null, originLine: 'http://127.0.0.1:4771' }],
  ['Host:127.0.0.1 + Origin:http://evil.com', { hostLine: '127.0.0.1', originLine: 'http://evil.com' }],
  ['Host:127.0.0.1 + Origin:null', { hostLine: '127.0.0.1', originLine: 'null' }],
  ['Host:127.0.0.1 + Origin:http://127.0.0.1:4771', { hostLine: '127.0.0.1', originLine: 'http://127.0.0.1:4771' }],
  ['Host:127.0.0.1 + Origin:http://127.0.0.1:8080 (port mismatch)', { hostLine: '127.0.0.1', originLine: 'http://127.0.0.1:8080' }],
  ['Host:127.0.0.1 + Origin:http://127.0.0.1.evil.com:4771', { hostLine: '127.0.0.1', originLine: 'http://127.0.0.1.evil.com:4771' }],
  ['Host:127.0.0.1 + Origin:http://[::1]:4771', { hostLine: '127.0.0.1', originLine: 'http://[::1]:4771' }],
];

for (const [label, cfg] of cases) {
  const resp = await rawRequest(cfg);
  console.log(`${status(resp).padStart(3)}  ${label}`);
}

console.log('\n=== HTTP/1.0 (no Host) ===');
console.log(`${status(await rawRequestHttp10())}  no Host, no Origin`);
console.log(`${status(await rawRequestHttp10({ originLine: 'http://evil.com' }))}  no Host + Origin:http://evil.com`);
console.log(`${status(await rawRequestHttp10({ originLine: 'http://127.0.0.1:4771' }))}  no Host + Origin:http://127.0.0.1:4771`);

console.log('\n=== Method reachability vs /save & /load (Host+Origin legit) ===');
for (const method of ['PUT', 'DELETE', 'PATCH', 'POST', 'GET']) {
  const base = { method, hostLine: '127.0.0.1', originLine: 'http://127.0.0.1:4771' };
  const s1 = status(await rawRequest({ ...base, path: '/save' }));
  const s2 = status(await rawRequest({ ...base, path: '/load' }));
  console.log(`${method.padEnd(7)} /save -> ${s1}   /load -> ${s2}`);
}
