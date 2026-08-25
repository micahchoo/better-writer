import net from 'node:net'

function raw(reqLines) {
  return new Promise((resolve) => {
    const s = net.connect(4599, '127.0.0.1', () => s.write(reqLines.join('\r\n') + '\r\n\r\n'))
    let buf = ''
    s.on('data', (d) => { buf += d })
    s.on('end', () => resolve(buf))
    s.on('error', (e) => resolve('ERR ' + e.message))
    setTimeout(() => { s.destroy(); resolve(buf) }, 1500)
  })
}
const head = (r) => r.split('\r\n\r\n')[0].split('\r\n')[0] + ' | ' + (r.split('\r\n\r\n')[1] ?? '').slice(0, 100).replace(/\n/g, '\\n')

console.log('A loopback Host      :', head(await raw(['GET /health HTTP/1.1', 'Host: 127.0.0.1:4599', 'Connection: close'])))
console.log('B attacker Host      :', head(await raw(['GET /health HTTP/1.1', 'Host: evil.example.com', 'Connection: close'])))
console.log('C Host trailing dot  :', head(await raw(['GET /health HTTP/1.1', 'Host: localhost.', 'Connection: close'])))
console.log('D Host uppercase     :', head(await raw(['GET /health HTTP/1.1', 'Host: LOCALHOST:4599', 'Connection: close'])))
console.log('E Origin uppercase   :', head(await raw(['GET /health HTTP/1.1', 'Host: localhost:4599', 'Origin: http://LOCALHOST:4599', 'Connection: close'])))
console.log('F no Host (HTTP/1.0) :', head(await raw(['GET /health HTTP/1.0', 'Connection: close'])))
console.log('G traversal raw      :', head(await raw(['GET /../../package.json HTTP/1.1', 'Host: 127.0.0.1:4599', 'Connection: close'])))
console.log('H traversal dotdot   :', head(await raw(['GET /..%2F..%2Fpackage.json HTTP/1.1', 'Host: 127.0.0.1:4599', 'Connection: close'])))
console.log('I traversal backslash:', head(await raw(['GET /..\\..\\package.json HTTP/1.1', 'Host: 127.0.0.1:4599', 'Connection: close'])))
console.log('J null byte          :', head(await raw(['GET /index.html%00.png HTTP/1.1', 'Host: 127.0.0.1:4599', 'Connection: close'])))
console.log('K load cross-origin  :', head(await raw(['GET /load HTTP/1.1', 'Host: 127.0.0.1:4599', 'Connection: close'])))
