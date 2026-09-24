/**
 * Stages the Python resources that ship inside the packaged app.
 *
 * The sidecar and the browser-use fork are dev trees that also contain things
 * that must never reach a user's installer:
 *
 *   product/sidecar/.venv     235 MB of this machine's virtualenv
 *   product/sidecar/profiles   11 MB of real browser profiles + cookies
 *   product/sidecar/sessions   local agent session state
 *   browser-use/.git           39 MB of upstream history
 *   __pycache__ dirs           stale bytecode from another interpreter
 *
 * So instead of shipping those directories wholesale, copy an explicit
 * allowlist into .forge-stage/, which forge.config.ts points extraResource at.
 * Run by the `prePackage` hook.
 *
 * Env:
 *   MYPILOT_SIDECAR_SRC      sidecar source tree (default: <product>/sidecar)
 *   MYPILOT_BROWSER_USE_SRC  browser-use fork (default: <product>/../browser-use)
 *   MYPILOT_STAGE_DIR        staging output (default: <app>/.forge-stage)
 *
 * The source overrides exist because CI does not share this monorepo layout: a
 * release job can check the sidecar and fork out separately and point these at
 * the checkout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productDir = path.resolve(appDir, '..', '..');
const sidecarSrc = path.resolve(process.env.MYPILOT_SIDECAR_SRC ?? path.join(productDir, 'sidecar'));
const browserUseSrc = path.resolve(
  process.env.MYPILOT_BROWSER_USE_SRC ?? path.join(productDir, '..', 'browser-use'),
);
const stageDir = path.resolve(process.env.MYPILOT_STAGE_DIR ?? path.join(appDir, '.forge-stage'));

/** Directories pruned from every copy. */
const PRUNED_DIRS = new Set(['__pycache__', '.git', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
/** Test trees pruned from the fork (never imported at runtime). */
const PRUNED_PATHS = new Set(['browser_use/tests', 'browser_use/agent/tests']);

function pruneFilter(relPath) {
  const parts = relPath.split(path.sep);
  if (parts.some((part) => PRUNED_DIRS.has(part))) return false;
  if (PRUNED_PATHS.has(parts.join('/'))) return false;
  if (relPath.endsWith('.pyc') || relPath.endsWith('.pyo')) return false;
  return true;
}

function copyInto(from, destRel, { optional = false } = {}) {
  if (!fs.existsSync(from)) {
    if (optional) {
      process.stdout.write(`  skip  ${path.relative(productDir, from)} (absent)\n`);
      return false;
    }
    throw new Error(`stage-sidecar-resources: missing required source ${from}`);
  }
  const to = path.join(stageDir, destRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: pruneFilter });
  process.stdout.write(`  add   ${destRel}\n`);
  return true;
}

function dirSizeMB(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* raced away */
        }
      }
    }
  };
  walk(dir);
  return total / (1024 * 1024);
}

/**
 * Drops the Google client libraries from the staged fork's dependency list.
 *
 * They resolve to ~102 MB of the payload (googleapiclient alone is 93 MB) and
 * are reachable only from browser_use/llm/google (Gemini) and
 * browser_use/integrations/gmail. MyPilot sends every LLM call through the
 * one-api router's OpenAI-compatible endpoint, so neither path is ever
 * imported. The vendored fork itself is left untouched so it stays
 * syncable with upstream; the prune is packaging-only, and
 * build-python-runtime.mjs smoke-tests `import browser_use` afterwards.
 */
function pruneGoogleDeps() {
  const pyproject = path.join(stageDir, 'browser-use', 'pyproject.toml');
  const original = fs.readFileSync(pyproject, 'utf8');
  const googleDeps = [
    'google-api-core',
    'google-genai',
    'google-api-python-client',
    'google-auth',
    'google-auth-oauthlib',
  ];
  const pruned = original
    .split('\n')
    .filter((line) => !googleDeps.some((dep) => line.trim().startsWith(`"${dep}`)))
    .join('\n');

  const removed = googleDeps.filter((dep) => original.includes(`"${dep}`));
  if (removed.length === 0) {
    throw new Error(
      'stage-sidecar-resources: no Google dependencies found to prune — update pruneGoogleDeps()',
    );
  }
  if (removed.length !== googleDeps.length) {
    throw new Error(
      `stage-sidecar-resources: expected to prune ${googleDeps.length} Google deps, pruned ${removed.length}`,
    );
  }
  fs.writeFileSync(pyproject, pruned);
  process.stdout.write(`  trim  browser-use/pyproject.toml (-${removed.join(', -')})\n`);
}

export function stageResources() {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  process.stdout.write('Staging Python resources for packaging:\n');

  // Sidecar: build backend (uv_build) needs pyproject.toml + src/.
  copyInto(path.join(sidecarSrc, 'pyproject.toml'), path.join('sidecar', 'pyproject.toml'));
  copyInto(path.join(sidecarSrc, 'src'), path.join('sidecar', 'src'));

  // The dev tree pins `browser-use` to ../../browser-use (editable), which is
  // correct at product/sidecar/ but resolves outside the bundle once staged to
  // .forge-stage/sidecar/. Repoint it at the staged fork and drop `editable` —
  // a shipped payload must resolve to a real copy, not a link into the repo.
  const stagedPyproject = path.join(stageDir, 'sidecar', 'pyproject.toml');
  const rewritten = fs
    .readFileSync(stagedPyproject, 'utf8')
    .replace(
      /browser-use\s*=\s*\{\s*path\s*=\s*"[^"]*browser-use"\s*,\s*editable\s*=\s*true\s*\}/,
      'browser-use = { path = "../browser-use" }',
    );
  if (!rewritten.includes('../browser-use')) {
    throw new Error(
      'stage-sidecar-resources: could not repoint [tool.uv.sources] browser-use at the staged fork',
    );
  }
  fs.writeFileSync(stagedPyproject, rewritten);
  process.stdout.write('  fix   sidecar/pyproject.toml uv.sources -> ../browser-use\n');

  // browser-use fork: hatchling builds only browser_use/**; pyproject declares
  // readme = "README.md", so that file must be present or the build fails.
  copyInto(path.join(browserUseSrc, 'pyproject.toml'), path.join('browser-use', 'pyproject.toml'));
  copyInto(path.join(browserUseSrc, 'README.md'), path.join('browser-use', 'README.md'));
  copyInto(path.join(browserUseSrc, 'browser_use'), path.join('browser-use', 'browser_use'));

  pruneGoogleDeps();

  // Guard rails: these must never appear in a shipped artifact.
  const forbidden = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (['__pycache__', '.venv', '.git', 'profiles', 'sessions'].includes(entry.name)) {
          forbidden.push(path.relative(stageDir, full));
        }
        walk(full);
      }
    }
  };
  walk(stageDir);
  if (forbidden.length > 0) {
    throw new Error(`stage-sidecar-resources: forbidden content staged: ${forbidden.join(', ')}`);
  }

  process.stdout.write(
    `Staged ${dirSizeMB(stageDir).toFixed(1)} MB into ${path.relative(process.cwd(), stageDir)}/ ` +
      `(sidecar + browser-use source only)\n`,
  );
  return stageDir;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    stageResources();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
