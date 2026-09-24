import { describe, expect, it } from 'vitest';
import {
  fingerprint,
  isContentFieldName,
  isSecretFieldName,
  redactSecretsInText,
  redactString,
  redactValue,
  sanitizeUrl,
} from '../../src/main/logRedaction';
import { sanitizeLogExtra } from '../../src/main/logger';

describe('log redaction', () => {
  it('classifies secret and content field names', () => {
    expect(isSecretFieldName('routerToken')).toBe(true);
    expect(isSecretFieldName('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSecretFieldName('password')).toBe(true);
    expect(isSecretFieldName('sessionId')).toBe(true);
    expect(isSecretFieldName('engineId')).toBe(false);

    expect(isContentFieldName('prompt')).toBe(true);
    expect(isContentFieldName('wrappedPrompt')).toBe(true);
    expect(isContentFieldName('summary')).toBe(true);
    expect(isContentFieldName('sessionId')).toBe(false);
  });

  it('replaces values of secret-named fields entirely', () => {
    expect(redactValue('routerToken', 'sk-abcdef123456')).toBe('[redacted]');
    expect(redactValue('password', 'hunter2')).toBe('[redacted]');
  });

  it('summarizes content fields instead of storing the text', () => {
    const redacted = redactValue('prompt', 'Book a flight to NYC for tomorrow');
    expect(typeof redacted).toBe('string');
    expect(redacted).not.toContain('NYC');
    expect(redacted).toMatch(/^len\d+:[0-9a-f]{8}$/);
  });

  it('strips credentials found in free text', () => {
    const text = 'failed with key sk-ant-api03-abcdefghijklmnop and token ghp_abcdefghijklmnopqrstuvwxyz123456';
    const out = redactSecretsInText(text);
    expect(out).not.toContain('sk-ant-api03');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(out).toContain('[redacted]');
  });

  it('strips authorization headers, JWTs, and AWS keys', () => {
    expect(redactSecretsInText('Authorization: Bearer abcdefghijklmnopqrst')).toContain('[redacted]');
    expect(
      redactSecretsInText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
    ).toContain('[redacted]');
    expect(redactSecretsInText('AKIAIOSFODNN7EXAMPLE')).toContain('[redacted]');
  });

  it('strips userinfo, query values, and fragments from URLs', () => {
    const sanitized = sanitizeUrl('https://user:pass@example.com/callback?code=abc123&state=xyz#frag');
    expect(sanitized).toContain('example.com/callback');
    expect(sanitized).not.toContain('abc123');
    expect(sanitized).not.toContain('user:pass');
    expect(sanitized).not.toContain('frag');
    // Key names survive so the flow is still identifiable.
    expect(sanitized).toContain('code=');
  });

  it('returns null for non-http URLs so they are not mangled', () => {
    expect(sanitizeUrl('not a url')).toBeNull();
    expect(sanitizeUrl('file:///tmp/x')).toBeNull();
  });

  it('redacts a bare URL string value', () => {
    const out = redactString('https://example.com/login?access_token=supersecretvalue');
    expect(out).not.toContain('supersecretvalue');
  });

  it('truncates long strings', () => {
    const out = redactString('a'.repeat(1000));
    expect(out.length).toBeLessThanOrEqual(301);
  });

  it('leaves ordinary diagnostics untouched', () => {
    expect(redactValue('engineId', 'browser-use-agent')).toBe('browser-use-agent');
    expect(redactValue('iter', 4)).toBe(4);
    expect(redactValue('ok', true)).toBe(true);
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactValue('payload', {
      nested: { token: 'sk-abcdef123456', keep: 'visible' },
      list: ['sk-abcdef123456', 'plain'],
    }) as Record<string, unknown>;
    const nested = out.nested as Record<string, unknown>;
    expect(nested.token).toBe('[redacted]');
    expect(nested.keep).toBe('visible');
    expect(out.list).toEqual(['[redacted]', 'plain']);
  });

  it('produces stable, non-reversible fingerprints', () => {
    const a = fingerprint('+15551234567');
    expect(a).toBe(fingerprint('+15551234567'));
    expect(a).not.toContain('5551234567');
    expect(a).not.toBe(fingerprint('+15559999999'));
  });

  it('applies redaction through the logger entry point', () => {
    const safe = sanitizeLogExtra({
      engineId: 'browser-use-agent',
      routerToken: 'sk-abcdef123456',
      url: 'https://example.com/cb?code=secretcode',
      prompt: 'my private task text',
    });
    expect(safe?.engineId).toBe('browser-use-agent');
    expect(safe?.routerToken).toBe('[redacted]');
    expect(String(safe?.url)).not.toContain('secretcode');
    expect(String(safe?.prompt)).not.toContain('private task text');
  });

  it('keeps reserved field names from clobbering log metadata', () => {
    const safe = sanitizeLogExtra({ ts: 'not-a-timestamp', level: 'info' });
    expect(safe?.extra_ts).toBe('not-a-timestamp');
    expect(safe?.extra_level).toBe('info');
  });
});
