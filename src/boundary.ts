/**
 * Local-machine boundary: reject requests that did not originate on this
 * machine's browser or shell.
 *
 * The server is a single-writer tool bound to the loopback interface. Two
 * remote attack paths remain even then:
 *  - CSRF/no-preflight writes: a hostile web page POSTs JSON as text/plain
 *    straight at http://127.0.0.1:<port>/save. Browsers attach an `Origin`
 *    header to every cross-origin request, preflight or not.
 *  - DNS rebinding: the attacker rebinds their domain to 127.0.0.1 and the
 *    browser sends requests whose `Host` names the attacker's domain,
 *    defeating same-origin policy entirely (full read AND write).
 *
 * Both die here: `Host` must name this machine, and any present `Origin`
 * must name the exact authority we listen on — the same loopback hostname
 * AND port. A foreign host, a different port, or a different hostname on
 * our port all fail closed. Absent headers are allowed — curl, tests, and
 * same-origin fetches send neither or matching values.
 */

/** Hostnames that denote the local machine when used in Host/Origin. */
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Strip an optional :port suffix from a Host/Origin authority, keeping IPv6 brackets intact. */
export function hostWithoutPort(authority: string): string {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return authority;
    // Anything after `]` must be exactly `:digits`. Returning the bracketed
    // part regardless meant "[::1]evil.com" normalized to loopback and would
    // have been ACCEPTED had the URL parse not crashed first (H4-1). Return
    // the whole string so the caller's loopback test fails it.
    const rest = authority.slice(close + 1);
    if (rest !== '' && !/^:\d+$/.test(rest)) return authority;
    return authority.slice(0, close + 1);
  }
  // Exactly one colon with digits behind it: host:port. Multiple colons mean
  // unbracketed IPv6, which carries no parseable port suffix.
  const colon = authority.lastIndexOf(':');
  const hasPort = authority.indexOf(':') === colon && colon !== -1 && /^\d+$/.test(authority.slice(colon + 1));
  return hasPort ? authority.slice(0, colon) : authority;
}

/**
 * The decision behind every guarded route. Returns a rejection reason or
 * null when the request may proceed.
 *
 * - `host` (the HTTP Host header) must be a loopback name or exactly match
 *   the explicitly configured listen address. `undefined` (HTTP/1.0-style)
 *   passes: only tools on the machine omit it.
 * - `origin` passes when absent or when it names the exact authority we
 *   listen on — the same loopback hostname AND the configured `listenPort`.
 *   A matching hostname on a different port is still a hostile page (CSRF),
 *   so it fails closed like every other mismatch — including file:// ("null")
 *   and any other scheme/host.
 *
 * Hostnames compare case-insensitively (RFC 3986 §3.2.2). Browsers already
 * lowercase the Origin via URL parsing, but the raw Host header does not, so
 * both halves are normalized here.
 */
export function boundaryViolation(
  listenAddress: string,
  listenPort: number,
  host: string | undefined,
  origin: string | undefined,
): string | null {
  const listenHost = listenAddress.toLowerCase();
  let hostName = listenHost;
  if (host !== undefined) {
    hostName = hostWithoutPort(host).toLowerCase();
    const known =
      LOCAL_HOSTNAMES.has(hostName) ||
      (listenAddress !== '0.0.0.0' && listenAddress !== '' && hostName === listenHost);
    if (!known) return `untrusted Host "${host}"`;
  } else {
    // No Host to compare against; fall back to the configured address below.
    hostName = listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost;
  }
  if (origin === undefined) return null;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    // file:// pages send "null"; anything unparseable fails closed too.
    return `cross-origin request from "${origin}"`;
  }
  // `originUrl.hostname` is already lowercased by URL parsing; `hostName` is
  // normalized above. Compare the full authority: hostname AND port. Any other
  // local service on this machine must not be able to CSRF /save from its own
  // port.
  if (originUrl.hostname !== hostName || originUrl.port !== String(listenPort)) {
    return `cross-origin request from "${origin}"`;
  }
  return null;
}
