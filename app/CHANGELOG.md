# Changelog

All notable changes to MyPilot are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Security
- Fixed path traversal in `sessions:download-output`
- Fixed ANSI injection in `streamToTerm.ts`
- Fixed XSS in `HtmlBlock.tsx` and `Markdown.tsx`
- Tightened IPC validation on `sessions:view-resize`
- Fixed TOCTOU race in `drainQueuedFollowUp`
- Guarded `ANTHROPIC_API_KEY` env fallback to non-production
- `maskKey` now reveals only last 4 characters

### Bug Fixes
- Fixed `BrowserPool.drainQueue` silently dropping queued sessions
- Fixed token double-counting in recovery (delta accumulation)
- Fixed Chromium revision sort (lexicographic → numeric)
- Fixed `hl:set-engine` silently ignoring payload
- Added timeout to `agent.run()` in sidecar recovery
- Fixed `SystemExit` in `emit()` killing agent runs
- Fixed `activeAgents` map leak on pill task completion
- Fixed `pill:cancel` not calling `terminateActiveRunControl`
- Fixed `engineSessionIds`/`sessionEngines` leak on session delete
- Fixed non-atomic harness write (temp dir + rename)
- Fixed `bootstrapHarness()` called before `app.whenReady()`
- Fixed blocking `appendFileSync` in logger (now async)
- Fixed Windows process table (was always empty, now uses `wmic`)
- Fixed `isPortFreeSync` returning `true` on error
- Fixed `harnessOwnerFromCommand` only matching one path
- Fixed TLD filter removing `io` (broke `github.io`)
- Fixed `CODE_RE` matching too broadly in codexLogin

### CI
- Added Python sidecar pytest job
- Added e2e Playwright job
- Removed stale nested CI workflow
- Removed duplicate `package-lock.json`

### Cleanup
- Removed duplicate test files (`ipcValidators`, `hotkeys`)
- Removed skipped a11y test (axe-core not installed)
- Removed stale `.track-F-*.md` references in forge.config
- Removed stale TypeScript ignore in dependabot.yml
- Added `CODEOWNERS` with `@IamFILINT`
- Fixed `CONTRIBUTING.md` path (`cd desktop` → `cd app`)
- Updated stale docs (`CURRENT_STATE.md`, `CI.md`, `PERFORMANCE.md`, `SECURITY.md`)

### Features
- Session-sticky model wiring (`RunEngineOptions.model`)
- BrowserCode adapter test coverage (parse errors, tool pairing)
- Distilled skill privacy (no task/URL/final persisted)
- Recovery cost accounting for failed attempts
