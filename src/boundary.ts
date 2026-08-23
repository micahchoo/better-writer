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
 * must point back at the exact authority in `Host`. Absent headers are
 * allowed — curl, tests, and same-origin fetches send neither or matching
 * values.
 */

/** Hostnames that denote the local machine when used in Host/Origin. */
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Strip an optional :port suffix from a Host/Origin authority, keeping IPv6 brackets intact. */
export function hostWithoutPort(authority: string): string {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    return close === -1 ? authority : authority.slice(0, close + 1);
  }
  // Exactly one colon with digits behind it: host:port. Multiple colons mean
  // unbracketed IPv6, which carries no parseable port suffix.
  const colon = authority.lastIndexOf(':');
  const hasPort = authority.indexOf(':') === colon && colon !== -1 && /^\d+$/.test(authority.slice(colon + 1));
  return hasPort ? authority.slice(0, colon) : authority;
}

/** Extract host-without-port from an Origin URL; null when it does not parse. */
function originHost(origin: string): string | null {
  try {
    return hostWithoutPort(new URL(origin).host);
  } catch {
    return null;
  }
}

/**
 * The decision behind every guarded route. Returns a rejection reason or
 * null when the request may proceed.
 *
 * - `host` (the HTTP Host header) must be a loopback name or exactly match
 *   the explicitly configured listen address. `undefined` (HTTP/1.0-style)
 *   passes: only tools on the machine omit it.
 * - `origin` passes when absent or when it resolves to the same authority
 *   as `Host`. Everything else — including file:// ("null") and any other
 *   scheme/host — fails closed.
 */
export function boundaryViolation(
  listenAddress: string,
  host: string | undefined,
  origin: string | undefined,
): string | null {
  let hostName = listenAddress;
  if (host !== undefined) {
    hostName = hostWithoutPort(host);
    const known =
      LOCAL_HOSTNAMES.has(hostName) ||
      (listenAddress !== '0.0.0.0' && listenAddress !== '' && hostName === listenAddress);
    if (!known) return `untrusted Host "${host}"`;
  } else {
    // No Host to compare against; fall back to the configured address below.
    hostName = listenAddress === '0.0.0.0' ? '127.0.0.1' : listenAddress;
  }
  if (origin === undefined) return null;
  if (originHost(origin) !== hostName) return `cross-origin request from "${origin}"`;
  return null;
}
