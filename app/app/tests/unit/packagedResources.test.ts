import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import forgeConfig from '../../forge.config';

const appRoot = path.resolve(__dirname, '../..');
const stageDir = path.join(appRoot, '.forge-stage');

type ExtraResource = string | { from: string; to?: string };

function extraResources(): string[] {
  const configured = forgeConfig.packagerConfig?.extraResource as ExtraResource[] | undefined;
  if (!Array.isArray(configured)) {
    throw new Error('Expected packagerConfig.extraResource to be an array');
  }
  return configured.map((entry) => (typeof entry === 'string' ? entry : entry.from));
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(stageDir, full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

describe('packaged python resources', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(appRoot, 'scripts/stage-sidecar-resources.mjs')], {
      stdio: 'pipe',
    });
  }, 60_000);

  it('ships the sidecar and browser-use fork from the staged allowlist, not the dev trees', () => {
    const resources = extraResources().map((entry) => path.resolve(entry));
    expect(resources).toContain(path.join(stageDir, 'sidecar'));
    expect(resources).toContain(path.join(stageDir, 'browser-use'));

    // The dev trees must never be an extraResource source: they contain the
    // local venv, real browser profiles, and upstream git history.
    const sidecarDev = path.resolve(appRoot, '..', 'sidecar');
    const forkDev = path.resolve(appRoot, '..', '..', 'browser-use');
    expect(resources).not.toContain(sidecarDev);
    expect(resources).not.toContain(forkDev);
  });

  it('stages the files the python build backends require', () => {
    expect(fs.existsSync(path.join(stageDir, 'sidecar/pyproject.toml'))).toBe(true);
    expect(fs.existsSync(path.join(stageDir, 'sidecar/src/bu_sidecar/__init__.py'))).toBe(true);
    // hatchling reads readme = "README.md" from the fork's pyproject metadata.
    expect(fs.existsSync(path.join(stageDir, 'browser-use/pyproject.toml'))).toBe(true);
    expect(fs.existsSync(path.join(stageDir, 'browser-use/README.md'))).toBe(true);
    expect(fs.existsSync(path.join(stageDir, 'browser-use/browser_use/__init__.py'))).toBe(true);
  });

  it('never stages venvs, browser profiles, sessions, git history, or bytecode', () => {
    const files = listFiles(stageDir);
    expect(files.length).toBeGreaterThan(0);

    const forbidden = files.filter(
      (file) =>
        file.includes(`${path.sep}__pycache__${path.sep}`) ||
        file.endsWith('.pyc') ||
        file.startsWith(`sidecar${path.sep}.venv${path.sep}`) ||
        file.startsWith(`sidecar${path.sep}profiles${path.sep}`) ||
        file.startsWith(`sidecar${path.sep}sessions${path.sep}`) ||
        file.includes(`${path.sep}.git${path.sep}`),
    );
    expect(forbidden).toEqual([]);
  });

  it('stages a payload small enough to ship', () => {
    let bytes = 0;
    for (const file of listFiles(stageDir)) {
      bytes += fs.statSync(path.join(stageDir, file)).size;
    }
    // The dev trees are ~297 MB (235 MB venv + 11 MB profiles + 39 MB .git).
    expect(bytes).toBeLessThan(32 * 1024 * 1024);
  });
});
