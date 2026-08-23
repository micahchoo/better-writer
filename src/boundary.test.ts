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
    expect(boundaryViolation('127.0.0.1', undefined, undefined)).toBeNull();
  });

  it('allows loopback Host with no Origin (same-origin fetch may omit it)', () => {
    expect(boundaryViolation('127.0.0.1', '127.0.0.1:4699', undefined)).toBeNull();
    expect(boundaryViolation('127.0.0.1', 'localhost:4699', undefined)).toBeNull();
  });

  it('rejects a foreign Host even with a matching Origin — DNS rebinding dies here', () => {
    const reason = boundaryViolation('127.0.0.1', 'evil.example:4699', 'http://evil.example:4699');
    expect(reason).toContain('untrusted Host');
  });

  it('rejects a cross-site Origin riding on a local Host — the text/plain CSRF primitive', () => {
    const reason = boundaryViolation('127.0.0.1', '127.0.0.1:4699', 'http://attacker.example');
    expect(reason).toContain('cross-origin');
  });

  it('allows an Origin whose authority matches the request Host', () => {
    expect(boundaryViolation('127.0.0.1', '127.0.0.1:4699', 'http://127.0.0.1:4699')).toBeNull();
  });

  it('fails closed on a malformed Origin ("null" from file:// pages)', () => {
    const reason = boundaryViolation('127.0.0.1', '127.0.0.1:4699', 'null');
    expect(reason).toContain('cross-origin');
  });

  it('compares IPv6 authorities without mangling brackets', () => {
    expect(boundaryViolation('[::1]', '[::1]:4699', 'http://[::1]:4699')).toBeNull();
  });
});
