# MyPilot — Current State

**Generated:** 2026-10-02 (post-audit fix sweep + first green CI)
**Branch:** `main`
**CI:** first run of record `36923047276` — all 7 jobs green

---

## Test Suite Results

Verified on GitHub Actions (ubuntu-latest, x64) in run `36923047276`, and
reproduced locally on Android/arm64 where noted.

| Suite | Runner | Result | Count | Notes |
|---|---|---|---|---|
| Unit + Integration | Vitest | PASS | 92 files passed, 2 skipped | zero failures on x64 |
| Python sidecar | pytest | PASS | 23/23 | 1 test file (test_recovery.py) |
| TypeScript typecheck | tsc | PASS | 0 errors | tsc --noEmit |
| ESLint | eslint | PASS | 0 errors | crashes locally (ARM64), fine on x64 |
| db:schema:check | ts-node + vitest | PASS | — | asserts SessionDb schema manifest |
| E2E (Playwright) | — | SKIPPED | — | needs `BROWSER_USE_FORK_URL` |

The 22 unit failures seen on an Android/arm64 host are environmental, not
code defects: `better-sqlite3` and `node-pty` have no prebuilt bindings for
that platform, and jsdom's `window.localStorage` is inert under Node 26 there.
All of them pass on x64 once the native modules build.

ESLint additionally aborts with SIGILL on ARM64 — `unrs-resolver` ships a
native binary incompatible with this CPU. This is why lint runs in CI rather
than locally.

---

## Architecture

### Desktop (Electron + Vite)
- **Main process:** `src/main/index.ts` (~2266 lines), `src/main/sessions/`, `src/main/hl/engines/`
- **Renderer:** `src/renderer/hub/`, `src/renderer/chat-v2/`
- **Preload bridges:** `src/preload/shell.ts`, `pill.ts`, `popup.ts`, `logs.ts`, `onboarding.ts`
- **Shared types:** `src/shared/session-schemas.ts` (Zod)

### Sidecar (Python)
- **Entry point:** `sidecar/src/bu_sidecar/__init__.py`
- **Recovery:** `sidecar/src/bu_sidecar/recovery.py`
- **Skills:** `sidecar/src/bu_sidecar/skills.py`
- **Tests:** `sidecar/tests/test_recovery.py`

### Engine Adapters
- **Claude Code:** `claude-code/adapter.ts` — `claude -p --output-format stream-json`
- **Codex:** `codex/adapter.ts` — `codex exec --json`
- **BrowserCode:** `browsercode/adapter.ts` — `bcode run --format json`
- **Browser Use Agent:** `browser-use-agent/adapter.ts` — Python sidecar via NDJSON

### Backend (separate repo)
- **BFF:** FastAPI — auth/OTP, rate limiting, quota, plan management
- **Router:** one-api fork — LLM routing/failover, usage ingest
- **Browser-use fork:** separate checkout

---

## Recent Changes (2026-09-30)

### Bug Fixes
- Fixed 6 critical bugs (session drop, token double-count, wrong binary, no timeout, SystemExit kill)
- Fixed 8 high-severity issues (resource leaks, lifecycle, blocking I/O, Windows support)
- Fixed 16 medium issues (security hardening, path traversal, XSS, ANSI injection)
- Fixed 15 low issues (dead code, duplicate tests, stale refs)

### CI: workflows had never run

Both workflows were committed under `app/.github/workflows/`. GitHub only
reads `<repo-root>/.github/workflows/`, so it registered zero workflows and
the repository had no CI, no release pipeline, no dependabot and no
CODEOWNERS enforcement. Moving them to the root exposed a second layer of
bugs: every path assumed the Electron app lived at `app/`, but it lives at
`app/app/`, and `app/package.json` / `app/yarn.lock` do not exist. Both the
workflows and `app/docker/linux.Dockerfile` assumed the flatter layout and
were repaired. See [CI.md](CI.md) for the corrected paths.

### CI Improvements
- Added Python sidecar pytest job
- Added e2e Playwright job
- Removed stale nested CI workflow
- Removed duplicate lockfile (package-lock.json)

### Security
- Fixed path traversal in sessions:download-output
- Fixed ANSI injection in streamToTerm
- Fixed XSS in HtmlBlock and Markdown
- Tightened IPC validation
- Guarded env var fallback to non-production

---

## Known Gaps

- `src/main/index.ts` is 2266 lines — needs splitting
- No i18n infrastructure
- Live view only for BYOK engines, not MyPilot Agent
- macOS builds are unsigned

Resolved since the first sweep:

- ~~No preload bridge tests in CI~~ — 24 added across `preload-shell.test.ts`
  and `preload-bridges.test.ts`, in the `unit` job.
- ~~No coverage gate enforced~~ — enforced in `unit` as a regression gate;
  see the threshold note in [CI.md](CI.md).

Still open, and both are external rather than code problems:

- **E2E never runs until `BROWSER_USE_FORK_URL` is set.** The repository
  currently has zero variables and zero secrets. The private browser-use fork
  is required by the forge `prePackage` staging step, so without it no
  packaged app can be produced anywhere — CI or locally.
- **The release pipeline has still never been executed.** Its paths are now
  correct against the real layout and verified by existence checks, but the
  first `workflow_dispatch` is the only true test.
