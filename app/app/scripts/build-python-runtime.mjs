/**
 * Builds the self-contained Python runtime that ships inside the packaged app.
 *
 * Output layout (consumed by src/main/hl/engines/browser-use-agent/runtime.ts):
 *
 *   .forge-stage/python-runtime/python/{bin/python3 | python.exe}
 *   .forge-stage/python-runtime/site-packages/...
 *
 * Why not a venv: venvs bake absolute paths and are not relocatable, which
 * breaks as soon as the app installs somewhere other than the build machine's
 * layout. A standalone interpreter plus a flat site-packages tree referenced via
 * PYTHONPATH is fully relocatable.
 *
 * The interpreter comes from `uv python install`, which fetches Astral's
 * relocatable python-build-standalone CPython. That payload has no system
 * Python dependency and no baked-in absolute paths.
 *
 * Run on each release platform in CI:
 *   node scripts/build-python-runtime.mjs
 *
 * Env:
 *   MYPILOT_PYTHON_VERSION  minor version to pin (default: 3.12)
 *   MYPILOT_SKIP_RUNTIME     set to 1 to skip (builds without the agent engine)
 *   MYPILOT_STAGE_DIR        staging dir to install from (default: <app>/.forge-stage)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stageDir = path.resolve(process.env.MYPILOT_STAGE_DIR ?? path.join(appDir, '.forge-stage'));
const runtimeDir = path.join(stageDir, 'python-runtime');

const PYTHON_VERSION = process.env.MYPILOT_PYTHON_VERSION ?? '3.12';

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status ?? res.signal}`);
  }
}

function capture(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * Ask uv for a managed CPython and return its install root. uv caches these
 * under its data dir, keyed by version+platform+arch, so repeated CI builds on
 * the same runner are cheap.
 */
function installManagedPython(version) {
  log(`  installing managed CPython ${version} via uv`);
  run('uv', ['python', 'install', version]);
  // --managed-python forces uv's own downloadable build rather than any system
  // interpreter, which is what makes the payload self-contained.
  const interpreter = capture('uv', ['python', 'find', version, '--managed-python']);
  if (!fs.existsSync(interpreter)) throw new Error(`uv reported no interpreter: ${interpreter}`);
  // .../<install-root>/bin/python3.12 -> <install-root>
  return path.resolve(path.dirname(interpreter), '..');
}

export function buildPythonRuntime() {
  if (process.env.MYPILOT_SKIP_RUNTIME === '1') {
    log('MYPILOT_SKIP_RUNTIME=1 — skipping bundled python runtime.');
    return null;
  }
  for (const required of [
    path.join(stageDir, 'sidecar'),
    path.join(stageDir, 'browser-use'),
  ]) {
    if (!fs.existsSync(required)) {
      throw new Error(
        `missing staged source ${required} — run scripts/stage-sidecar-resources.mjs first (prePackage does this)`,
      );
    }
  }

  log(`Building bundled python runtime (CPython ${PYTHON_VERSION}, ${process.platform}-${process.arch})`);

  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const managedRoot = installManagedPython(PYTHON_VERSION);
  const pythonRoot = path.join(runtimeDir, 'python');
  log(`  copying interpreter from ${managedRoot}`);
  fs.cpSync(managedRoot, pythonRoot, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(managedRoot, src);
      // Cached wheels/stdlib archives the app never reads at runtime.
      return !rel.split(path.sep).some((p) => p === '__pycache__' || p === '.git');
    },
  });

  const python =
    process.platform === 'win32'
      ? path.join(pythonRoot, 'python.exe')
      : path.join(pythonRoot, 'bin', 'python3');
  if (!fs.existsSync(python)) throw new Error(`interpreter missing after copy: ${python}`);

  // Flat target install: no venv, no absolute-path scripts. `uv` resolves and
  // downloads every wheel for this platform/arch, including the local fork.
  const sitePackages = path.join(runtimeDir, 'site-packages');
  fs.mkdirSync(sitePackages, { recursive: true });
  log('  installing sidecar + browser-use fork into site-packages');
  run('uv', [
    'pip',
    'install',
    '--python',
    python,
    '--target',
    sitePackages,
    '--prerelease',
    'allow',
    path.join(stageDir, 'browser-use'),
    path.join(stageDir, 'sidecar'),
  ]);

  // Console scripts and bytecode are dead weight: the app launches the module
  // directly, and stale bytecode from the build interpreter is never valid for
  // the shipped one.
  pruneSitePackages(sitePackages);

  // Verify the payload actually runs before it can reach an installer.
  const smoke = spawnSync(python, ['-c', 'import bu_sidecar, browser_use; print(bu_sidecar.__name__)'], {
    encoding: 'utf-8',
    env: { ...process.env, PYTHONPATH: sitePackages },
  });
  if (smoke.status !== 0) {
    throw new Error(`runtime smoke test failed: ${smoke.stderr || smoke.stdout}`);
  }
  log(`  smoke test ok (${(smoke.stdout || '').trim()})`);

  fs.writeFileSync(
    path.join(runtimeDir, 'runtime.json'),
    `${JSON.stringify(
      {
        python: capture(python, ['--version']).replace(/^Python /, ''),
        platform: process.platform,
        arch: process.arch,
      },
      null,
      2,
    )}\n`,
  );

  const mb = dirSizeMB(runtimeDir);
  log(`Bundled python runtime: ${mb.toFixed(1)} MB at ${path.relative(process.cwd(), runtimeDir)}`);
  if (mb > 400) {
    log('WARNING: runtime payload exceeds 400 MB — check for unpruned optional dependencies.');
  }
  return runtimeDir;
}

function pruneSitePackages(sitePackages) {
  for (const entry of fs.readdirSync(sitePackages, { withFileTypes: true })) {
    const full = path.join(sitePackages, entry.name);
    if (entry.isDirectory() && entry.name === '__pycache__') {
      fs.rmSync(full, { recursive: true, force: true });
    }
    if (entry.isDirectory() && (entry.name === 'bin' || entry.name === 'Scripts')) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
  // Nested __pycache__ dirs.
  const stack = [sitePackages];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (entry.name === '__pycache__') {
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        stack.push(full);
      }
    }
  }
}

function dirSizeMB(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* raced */
        }
      }
    }
  }
  return total / (1024 * 1024);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    buildPythonRuntime();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
