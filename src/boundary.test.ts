import { describe, expect, it } from 'vitest';
import { boundaryViolation, hostWithoutPort } from './boundary';

describe('hostWithoutPort', () => {
  it.each([
    ['127.0.0.1:4699', '127.0.0.1'],
    ['localhost:4517', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['[::1]:4699', '[::1]'],
    ['::1', '::1'],
  ])('strips the port from %s', (authority, want) => {
    expect(hostWithoutPort(authority)).toBe(want);
  });
});

describe('boundaryViolation', () => {
  it('allows headerless requests (curl, tests)', () => {
    expect(boundaryViolation('127.0.0.1', 4699, undefined, undefined)).toBeNull();
  });

  it('allows loopback Host with no Origin (same-origin fetch may omit it)', () => {
    expect(boundaryViolation('127.0.0.1', 4699, '127.0.0.1:4699', undefined)).toBeNull();
    expect(boundaryViolation('127.0.0.1', 4699, 'localhost:4699', undefined)).toBeNull();
  });

  it('rejects a foreign Host even with a matching Origin — DNS rebinding dies here', () => {
    const reason = boundaryViolation('127.0.0.1', 4699, 'evil.example:4699', 'http://evil.example:4699');
    expect(reason).toContain('untrusted Host');
  });

  it('rejects a cross-site Origin riding on a local Host — the text/plain CSRF primitive', () => {
    const reason = boundaryViolation('127.0.0.1', 4699, '127.0.0.1:4699', 'http://attacker.example');
    expect(reason).toContain('cross-origin');
  });

  it('allows an Origin whose authority matches the request Host', () => {
    expect(boundaryViolation('127.0.0.1', 4699, '127.0.0.1:4699', 'http://127.0.0.1:4699')).toBeNull();
  });

  it('rejects a cross-port loopback Origin — another local service cannot CSRF /save', () => {
    const reason = boundaryViolation('127.0.0.1', 4699, '127.0.0.1:4699', 'http://127.0.0.1:9999');
    expect(reason).toContain('cross-origin');
  });

  it('rejects a loopback Origin with no explicit port when listening on a real port', () => {
    const reason = boundaryViolation('127.0.0.1', 4699, '127.0.0.1:4699', 'http://127.0.0.1');
    expect(reason).toContain('cross-origin');
  });

  it('keeps rejecting a localhost-alias Origin (127.0.0.1 vs localhost) even on the same port', () => {
    const reason = boundaryViolation('127.0.0.1', 4699, 'localhost:4699', 'http://127.0.0.1:4699');
    expect(reason).toContain('cross-origin');
  });

  it('fails closed on a malformed Origin ("null" from file:// pages)', () => {
    const reason = boundaryViolation('127.0.0.1', 4699, '127.0.0.1:4699', 'null');
    expect(reason).toContain('cross-origin');
  });

  it('compares IPv6 authorities without mangling brackets', () => {
    expect(boundaryViolation('[::1]', 4699, '[::1]:4699', 'http://[::1]:4699')).toBeNull();
  });

  it('accepts an uppercase Host header when hostname and port match (RFC 3986 case-insensitive)', () => {
    expect(boundaryViolation('127.0.0.1', 4699, 'LOCALHOST:4699', 'http://localhost:4699')).toBeNull();
    expect(boundaryViolation('127.0.0.1', 4699, 'LOCALHOST:4699', 'http://LOCALHOST:4699')).toBeNull();
  });

  it('still rejects an uppercase Host on a foreign port — case fix does not weaken the port fix', () => {
    const reason = boundaryViolation('127.0.0.1', 4699, 'LOCALHOST:4699', 'http://localhost:9999');
    expect(reason).toContain('cross-origin');
  });
});
