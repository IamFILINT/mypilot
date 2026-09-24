/**
 * Sidecar runtime management: a per-user Python venv under Electron
 * userData holding the bu-sidecar package (OSS browser-use agent).
 *
 * Lifecycle:
 *   1. ensureSidecarRuntime() on first session (or settings action)
 *      - locates a python3.11+ interpreter per-OS
 *      - creates <userData>/sidecar-venv
 *      - uv pip installs ./sidecar (bundled with the app) into it
 *      - installs patchright chromium if no stealth browser found
 *   2. sidecarBinPath() gives the absolute launcher path:
 *      - unix:    <venv>/bin/bu-sidecar
 *      - windows: <venv>/Scripts/bu-sidecar.exe
 *
 * Fallback when the runtime isn't provisioned yet: `bu-sidecar` from
 * PATH (developer machines with uv/pip installs).
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { mainLogger } from '../../../logger';

export const SIDECAR_VENV_DIR = 'sidecar-venv';

function hasPyproject(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'pyproject.toml')).isFile();
  } catch {
    return false;
  }
}

/** Walk up from `start` looking for a directory (by name) with a pyproject. */
function findRepoDir(start: string, name: string, maxDepth = 6): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(dir, name);
    if (hasPyproject(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Sidecar package source shipped inside the app resources (or the dev repo). */
export function sidecarPackageSource(): string {
  const packagedPath = path.join(process.resourcesPath, 'sidecar');
  if (hasPyproject(packagedPath)) return packagedPath;
  // Dev: the sidecar lives next to the app repo (<product>/sidecar); walk up
  // from the app dir / CWD since __dirname is the bundled .vite/build dir.
  for (const root of [app.getAppPath(), process.cwd()]) {
    const found = findRepoDir(root, 'sidecar');
    if (found) return found;
  }
  return packagedPath;
}

/** Local browser-use fork (dev: <product>/browser-use; packaged: resources/browser-use). */
export function browserUseSource(): string | null {
  const packagedPath = path.join(process.resourcesPath, 'browser-use');
  if (hasPyproject(packagedPath)) return packagedPath;
  for (const root of [app.getAppPath(), process.cwd()]) {
    const found = findRepoDir(root, 'browser-use');
    if (found) return found;
  }
  return null;
}

export function sidecarVenvPath(): string {
  return path.join(app.getPath('userData'), SIDECAR_VENV_DIR);
}

export function sidecarBinPath(): string | null {
  const venv = sidecarVenvPath();
  const rel = process.platform === 'win32'
    ? path.join('Scripts', 'bu-sidecar.exe')
    : path.join('bin', 'bu-sidecar');
  const bin = path.join(venv, rel);
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch {
    return null;
  }
}

// ── bundled python runtime ───────────────────────────────────────────────────
//
// Packaged builds ship a self-contained CPython plus a prebuilt site-packages
// tree (see scripts/build-python-runtime.mjs). It needs no system Python, no
// venv creation, and no network on first launch. Layout:
//
//   resources/python-runtime/python/{bin/python3 | python.exe}
//   resources/python-runtime/site-packages/bu_sidecar/...
//
// The sidecar is launched as `python -m bu_sidecar` with PYTHONPATH pointing at
// site-packages, which sidesteps venv relocatability entirely.

export const PYTHON_RUNTIME_DIR = 'python-runtime';

/** Explicit override, used by tests and portable installs. */
const RUNTIME_DIR_ENV = 'MYPILOT_PYTHON_RUNTIME_DIR';

export function pythonExeIn(runtimeDir: string): string {
  return process.platform === 'win32'
    ? path.join(runtimeDir, 'python', 'python.exe')
    : path.join(runtimeDir, 'python', 'bin', 'python3');
}

function sitePackagesIn(runtimeDir: string): string {
  return path.join(runtimeDir, 'site-packages');
}

function isCompleteRuntime(dir: string): boolean {
  try {
    return (
      fs.statSync(pythonExeIn(dir)).isFile() &&
      fs.statSync(path.join(sitePackagesIn(dir), 'bu_sidecar', '__init__.py')).isFile()
    );
  } catch {
    return false;
  }
}

/** Locate the bundled runtime, or null when this build/platform has none. */
export function pythonRuntimeDir(): string | null {
  const override = process.env[RUNTIME_DIR_ENV];
  if (override && isCompleteRuntime(override)) return override;
  const packaged = path.join(process.resourcesPath ?? '', PYTHON_RUNTIME_DIR);
  if (isCompleteRuntime(packaged)) return packaged;
  for (const root of [app.getAppPath?.(), process.cwd()]) {
    if (!root) continue;
    const candidate = path.join(root, '.forge-stage', PYTHON_RUNTIME_DIR);
    if (isCompleteRuntime(candidate)) return candidate;
  }
  return null;
}

export interface SidecarLauncher {
  command: string;
  args: string[];
  /** Extra environment (PYTHONPATH) the command needs. */
  env: NodeJS.ProcessEnv;
  kind: 'bundled' | 'venv';
}

/**
 * How to start the sidecar, preferring the bundled runtime over a
 * user-provisioned venv. Returns null when neither exists, in which case the
 * caller may fall back to a `bu-sidecar` on PATH (dev machines).
 */
export function resolveSidecarLauncher(): SidecarLauncher | null {
  const runtime = pythonRuntimeDir();
  if (runtime) {
    return {
      command: pythonExeIn(runtime),
      args: ['-m', 'bu_sidecar'],
      env: { PYTHONPATH: sitePackagesIn(runtime) },
      kind: 'bundled',
    };
  }
  const venvBin = sidecarBinPath();
  if (venvBin) return { command: venvBin, args: [], env: {}, kind: 'venv' };
  return null;
}

interface PythonCandidate {
  bin: string;
  args: string[];
}

function probePythonVersion(bin: string, args: string[] = []): string | null {
  try {
    const r = spawnSync(bin, [...args, '--version'], { encoding: 'utf-8', timeout: 5000 });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    const m = r.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (major > 3 || (major === 3 && minor >= 11)) return `${m[1]}.${m[2]}.${m[3]}`;
    return null;
  } catch {
    return null;
  }
}

export function findPython(): PythonCandidate | null {
  const candidates: PythonCandidate[] = [];
  if (process.platform === 'win32') {
    for (const bin of ['py', 'python', 'python3']) {
      candidates.push({ bin, args: bin === 'py' ? ['-3'] : [] });
    }
  } else {
    for (const bin of ['python3.12', 'python3.11', 'python3', 'python']) {
      candidates.push({ bin, args: [] });
    }
  }
  for (const c of candidates) {
    const v = probePythonVersion(c.bin, c.args);
    if (v) {
      mainLogger.info('sidecar.python.found', { bin: c.bin, args: c.args, version: v });
      return c;
    }
  }
  return null;
}

function runCapture(bin: string, args: string[], timeoutMs = 300000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); if (stdout.length > 4096) stdout = stdout.slice(-4096); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > 8192) stderr = stderr.slice(-8192); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err) });
    });
  });
}

let provisioning: Promise<boolean> | null = null;

/**
 * Best-effort install of patchright's stealth Chromium into the app venv.
 * Non-fatal: the sidecar falls back to the browser-use-core managed Chromium
 * when patchright's binary is missing. Runs only when no existing stealth
 * Chromium is found under the platform playwright cache.
 */
async function ensureStealthChromium(venvDir: string): Promise<boolean> {
  const bin = process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
  const pyBin = path.join(venvDir, bin);
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
  ].filter((c): c is string => Boolean(c));
  const hasChromium = caches.some((cache) => {
    try { return fs.readdirSync(cache).some((name) => name.startsWith('chromium-')); } catch { return false; }
  });
  if (hasChromium) return true;
  const installPkg = await runCapture(pyBin, ['-m', 'pip', 'install', '--no-input', '--prefer-binary', 'patchright'], 300000);
  if (installPkg.code !== 0) return false;
  const installBin = await runCapture(pyBin, ['-m', 'patchright', 'install', 'chromium'], 600000);
  return installBin.code === 0;
}

export function ensureSidecarRuntime(): Promise<boolean> {
  // Bundled runtime: nothing to provision — no system Python, no venv, no pip.
  if (pythonRuntimeDir()) return Promise.resolve(true);
  if (sidecarBinPath()) return Promise.resolve(true);
  if (provisioning) return provisioning;

  provisioning = (async (): Promise<boolean> => {
    const py = findPython();
    if (!py) {
      mainLogger.error('sidecar.provision.noPython');
      return false;
    }
    const venv = sidecarVenvPath();
    mainLogger.info('sidecar.provision.start', { venv });

    // 1. venv
    const mk = await runCapture(py.bin, [...py.args, '-m', 'venv', venv]);
    if (mk.code !== 0) {
      mainLogger.error('sidecar.provision.venvFailed', { stderr: mk.stderr.slice(-500) });
      return false;
    }
    const pip = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'pip.exe' : 'pip');

    // 2. install the sidecar package (bundled source). The OSS browser-use
    //    fork is installed in the SAME pip invocation so the sidecar's
    //    `browser-use` dependency resolves to the local tree — pip never
    //    pulls the PyPI copy. When no fork is bundled, the declared
    //    dependency installs from PyPI as-is.
    const src = sidecarPackageSource();
    const forkSrc = browserUseSource();
    const targets = forkSrc ? [forkSrc, src] : [src];
    const install = await runCapture(pip, ['install', '--no-input', '--prefer-binary', ...targets]);
    if (install.code !== 0) {
      mainLogger.error('sidecar.provision.installFailed', { src, forkSrc, stderr: install.stderr.slice(-800) });
      return false;
    }

    // 3. ensure a stealth Chromium for patchright when the profile doesn't
    //    already have a browser installed.
    const stealthOk = await ensureStealthChromium(venv);
    if (!stealthOk) mainLogger.warn('sidecar.provision.stealthSkipped');

    mainLogger.info('sidecar.provision.done', { venv });
    return sidecarBinPath() != null;
  })();

  const clear = () => { provisioning = null; };
  provisioning.then(clear, clear);
  return provisioning;
}
