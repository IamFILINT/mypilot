import { describe, expect, it } from 'vitest';
import { isDeniedChildEnvVar, sanitizedChildEnv } from '../../../src/main/hl/engines/childEnv';

describe('spawned engine environment', () => {
  it('passes through the variables a CLI needs to function', () => {
    const env = sanitizedChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      SystemRoot: 'C:\\Windows',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      SSL_CERT_FILE: '/etc/ssl/corp.pem',
      DISPLAY: ':0',
      TEMP: '/tmp',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.HTTPS_PROXY).toBe('http://proxy:3128');
    expect(env.SSL_CERT_FILE).toBe('/etc/ssl/corp.pem');
    expect(env.DISPLAY).toBe(':0');
    expect(env.TEMP).toBe('/tmp');
  });

  it('drops unrelated credentials that were in the desktop environment', () => {
    const env = sanitizedChildEnv({
      PATH: '/usr/bin',
      AWS_SECRET_ACCESS_KEY: 'super-secret',
      GITHUB_TOKEN: 'ghp_example',
      ANTHROPIC_API_KEY: 'sk-ant-leak',
      OPENAI_API_KEY: 'sk-leak',
      SOME_RANDOM_SECRET: 'nope',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SOME_RANDOM_SECRET).toBeUndefined();
  });

  it('keeps the router token out of the inherited base environment', () => {
    // The adapter sets BU_ROUTER_TOKEN explicitly per run; a stale value in the
    // desktop environment must not become a default for other engines.
    const env = sanitizedChildEnv({ PATH: '/usr/bin', BU_ROUTER_TOKEN: 'sk-stale' });
    expect(env.BU_ROUTER_TOKEN).toBeUndefined();
  });

  it('matches allowlist entries case-insensitively', () => {
    const env = sanitizedChildEnv({ Path: '/usr/bin', home: '/home/u' });
    expect(env.Path).toBe('/usr/bin');
    expect(env.home).toBe('/home/u');
  });

  it('skips undefined values instead of stringifying them', () => {
    const env = sanitizedChildEnv({ PATH: '/usr/bin', HOME: undefined });
    expect('HOME' in env).toBe(false);
  });

  it('reports denied variables for the denylist', () => {
    expect(isDeniedChildEnvVar('ANTHROPIC_API_KEY')).toBe(true);
    expect(isDeniedChildEnvVar('aws_secret_access_key')).toBe(true);
    expect(isDeniedChildEnvVar('PATH')).toBe(false);
  });
});
