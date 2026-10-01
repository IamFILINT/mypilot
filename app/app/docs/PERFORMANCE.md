# MyPilot — Performance Notes

**Date:** 2026-09-30
**Node:** 22.x | Electron: 41.x | Vite: 6.x | React: 19.x

---

## Bundle Size Targets

| Renderer | JS Bundle | CSS Bundle | Total | Status |
|----------|-----------|------------|-------|--------|
| shell (hub) | ~200 KB | ~10 KB | ~210 KB | PASS (<400KB) |
| pill | ~150 KB | ~5 KB | ~155 KB | PASS (<400KB) |
| onboarding | ~100 KB | ~5 KB | ~105 KB | PASS (<400KB) |
| logs | ~80 KB | ~5 KB | ~85 KB | PASS (<400KB) |
| popup | ~50 KB | ~2 KB | ~52 KB | PASS (<400KB) |

**Main process:** ~120 KB (PASS <200KB)

---

## Performance Characteristics

- **Startup:** Vite build, lazy-loaded renderers
- **Memory:** BrowserPool caps concurrent sessions, idle freezing via CDP
- **Logging:** Async appendFile (non-blocking), 10MB rotation
- **Resource monitoring:** 15s interval, async process table reads

---

## Known Performance Considerations

- `sessionsStore.appendEvent` caps output at 1000 entries per session
- `BrowserPool` limits concurrent browser views
- Sidecar uses `asyncio.wait_for` timeout on agent.run() (30min default)
- Logger uses fire-and-forget async writes to avoid blocking event loop
