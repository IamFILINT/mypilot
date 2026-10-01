# MyPilot — Current State

**Generated:** 2026-09-30 (post-audit fix sweep)
**Branch:** `main`

---

## Test Suite Results

| Suite | Runner | Result | Count | Notes |
|---|---|---|---|---|
| Unit + Integration | Vitest | PASS | ~500+ tests | ~60 test files |
| Python sidecar | pytest | PASS | 23/23 | 1 test file (test_recovery.py) |
| TypeScript typecheck | tsc | PASS | 0 errors | tsc --noEmit |
| ESLint | eslint | PASS | 0 errors | ESLint 10, flat config |

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
- No preload bridge tests in CI
- No coverage gate enforced
- No i18n infrastructure
- Live view only for BYOK engines, not MyPilot Agent
- macOS builds are unsigned
