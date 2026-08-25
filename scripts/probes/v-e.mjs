import net from 'node:net'
const PORT = 4773
function raw(hostHeader, path = '/health', method = 'GET', body = '') {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => {
      const head = [`${method} ${path} HTTP/1.1`, `Host: ${hostHeader}`, 'Connection: close']
      if (body) head.push(`Content-Length: ${Buffer.byteLength(body)}`, 'Content-Type: application/json')
      s.write(head.join('\r\n') + '\r\n\r\n' + body)
    })
    let d = ''
    s.on('data', (c) => { d += c })
    s.on('close', () => resolve(d.split('\r\n')[0] + ' | ' + d.slice(d.indexOf('\r\n\r\n') + 4).slice(0, 90)))
    s.on('error', (e) => resolve('ERR ' + e.message))
  })
}
console.log('=== H4-1: malformed Host (was 500) ===')
for (const h of ['[::1]evil.com', '[::1]:evil', '127.0.0.1:evil', '127.0.0.1:999999', '::1'])
  console.log(' ', h.padEnd(18), await raw(h))
console.log('  control (valid loopback):', await raw('127.0.0.1:' + PORT))
console.log('\n=== H4-2: oversized body (was 200 + 50MB written) ===')
console.log('  50MB /save :', await raw('127.0.0.1:' + PORT, '/save', 'POST', JSON.stringify({ draft: 'x'.repeat(50 * 1024 * 1024) })))
console.log('  small /save:', await raw('127.0.0.1:' + PORT, '/save', 'POST', JSON.stringify({ draft: 'hello' })))
