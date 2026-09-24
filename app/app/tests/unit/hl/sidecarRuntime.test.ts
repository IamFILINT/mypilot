import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const RUNTIME_ENV = 'MYPILOT_PYTHON_RUNTIME_DIR';

/** Build a minimal but structurally complete bundled runtime. */
function makeRuntime(root: string): string {
  const dir = path.join(root, 'python-runtime');
  const python =
    process.platform === 'win32'
      ? path.join(dir, 'python', 'python.exe')
      : path.join(dir, 'python', 'bin', 'python3');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, '#!/bin/sh\n');
  fs.mkdirSync(path.join(dir, 'site-packages', 'bu_sidecar'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'site-packages', 'bu_sidecar', '__init__.py'), '');
  return dir;
}

describe('bundled python runtime resolution', () => {
  let tmp: string;
  let previous: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mypilot-runtime-'));
    previous = process.env[RUNTIME_ENV];
    delete process.env[RUNTIME_ENV];
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[RUNTIME_ENV];
    else process.env[RUNTIME_ENV] = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('never selects an incomplete override tree', async () => {
    const incomplete = path.join(tmp, 'missing');
    process.env[RUNTIME_ENV] = incomplete;
    const { pythonRuntimeDir, resolveSidecarLauncher } = await import(
      '../../../src/main/hl/engines/browser-use-agent/runtime'
    );
    // A developer machine may still have a real staged runtime, so assert the
    // contract that matters: the incomplete override is never chosen.
    expect(pythonRuntimeDir()).not.toBe(incomplete);
    const launcher = resolveSidecarLauncher();
    expect(launcher?.command.startsWith(incomplete) ?? false).toBe(false);
  });

  it('launches the bundled runtime via python -m with PYTHONPATH, not a venv script', async () => {
    const dir = makeRuntime(tmp);
    process.env[RUNTIME_ENV] = dir;
    const { pythonRuntimeDir, resolveSidecarLauncher } = await import(
      '../../../src/main/hl/engines/browser-use-agent/runtime'
    );

    expect(pythonRuntimeDir()).toBe(dir);
    const launcher = resolveSidecarLauncher();
    expect(launcher).not.toBeNull();
    expect(launcher?.kind).toBe('bundled');
    expect(launcher?.args).toEqual(['-m', 'bu_sidecar']);
    // No venv: the command is the interpreter itself, not a console script.
    expect(path.basename(launcher?.command ?? '')).toMatch(/^python3?(\.exe)?$/);
    expect(launcher?.env.PYTHONPATH).toBe(path.join(dir, 'site-packages'));
  });

  it('treats a runtime missing the sidecar package as incomplete', async () => {
    const dir = makeRuntime(tmp);
    fs.rmSync(path.join(dir, 'site-packages', 'bu_sidecar'), { recursive: true, force: true });
    process.env[RUNTIME_ENV] = dir;
    const { pythonRuntimeDir } = await import(
      '../../../src/main/hl/engines/browser-use-agent/runtime'
    );
    expect(pythonRuntimeDir()).not.toBe(dir);
  });

  it('exposes the interpreter path shape the build script produces', async () => {
    const dir = makeRuntime(tmp);
    process.env[RUNTIME_ENV] = dir;
    const { pythonExeIn } = await import(
      '../../../src/main/hl/engines/browser-use-agent/runtime'
    );
    const exe = pythonExeIn(dir);
    expect(fs.existsSync(exe)).toBe(true);
    expect(exe.startsWith(path.join(dir, 'python'))).toBe(true);
  });

  it('short-circuits provisioning when a bundled runtime is present', async () => {
    const dir = makeRuntime(tmp);
    process.env[RUNTIME_ENV] = dir;
    const { ensureSidecarRuntime } = await import(
      '../../../src/main/hl/engines/browser-use-agent/runtime'
    );
    // Must resolve without touching system Python or pip.
    await expect(ensureSidecarRuntime()).resolves.toBe(true);
  });
});
