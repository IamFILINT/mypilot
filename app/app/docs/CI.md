# CI + Local Testing

## Workflows

### `ci.yml` — every PR + push to `main`

| Job | Runner | Gates merge? | What it runs |
|---|---|---|---|
| `lint` | ubuntu | **yes** | `yarn lint` — ESLint |
| `typecheck` | ubuntu | **yes** | `yarn typecheck` — tsc --noEmit |
| `unit` | ubuntu | **yes** | `yarn test:coverage` — vitest + coverage |
| `windows-spawn` | windows | **yes** | Windows-only spawn tests |
| `linux-spawn` | ubuntu | **yes** | Linux-only spawn tests |
| `sidecar` | ubuntu | **yes** | `uv run pytest` + `uv run ruff check` |
| `e2e` | ubuntu | **no** | Playwright e2e tests |

### `release.yml` — tag-driven GitHub Release

- macOS: signs, notarizes, builds DMG
- Windows: builds Squirrel installer
- Linux: builds in Docker

---

## Local Development

```bash
# Install dependencies
cd app
yarn install

# Run lint
yarn lint

# Run typecheck
yarn typecheck

# Run unit tests
yarn test

# Run e2e tests
yarn e2e

# Run sidecar tests
cd ../sidecar
uv sync --frozen
uv run pytest tests/ -v
uv run ruff check src/ tests/

# Build
yarn make
```
