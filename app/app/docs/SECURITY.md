# MyPilot — Security Review

**Date:** 2026-09-30 (post-audit fix sweep)
**Scope:** `src/main/`, `src/preload/`, `src/renderer/`, `sidecar/`

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0 | — |
| High | 0 | All fixed |
| Medium | 0 | All fixed |
| Low | 0 | All fixed |

**Overall risk:** LOW after 2026-09-30 audit fix sweep.

## Fixed in 2026-09-30

- Path traversal in `sessions:download-output` — fixed with proper path validation
- ANSI injection in `streamToTerm.ts` — fixed with stripAnsi on all agent text
- XSS in `HtmlBlock.tsx` — fixed with HTML sanitization
- XSS in `Markdown.tsx` — fixed with defaultUrlTransform
- IPC validation in `sessions:view-resize` — fixed with assertString
- TOCTOU race in `drainQueuedFollowUp` — fixed with atomic set-and-check
- `ANTHROPIC_API_KEY` env fallback — guarded to non-production
- `maskKey` reveals only last 4 chars

## Security Posture

- All IPC handlers validate input with Zod or assert functions
- Renderer is sandboxed (`sandbox: true`)
- Context isolation enabled
- No secrets in source code or logs
- API keys stored in OS keychain
- LLM output treated as untrusted input
