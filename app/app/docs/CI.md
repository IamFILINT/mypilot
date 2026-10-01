# CI + Local Testing

## Where the workflows live

Workflows must be committed to **`<repo-root>/.github/workflows/`**. GitHub
Actions ignores that directory anywhere else, with no error — the workflow
simply never appears in the Actions tab. This repository's `ci.yml` and
`release.yml` were originally committed under `app/.github/workflows/`, so
nothing had ever run: `gh api repos/IamFILINT/mypilot/actions/workflows`
returned `total_count: 0`. If a workflow appears to be "not triggering",
check its path before anything else.

Note the layout the paths below assume. The Electron app is **`app/app`**, not
`app/`; `app/` is the product workspace that also holds `app/scripts/`,
`app/docker/` and `app/shared/`. There is no `app/package.json` and no
`app/yarn.lock` — both live in `app/app/`. `sidecar/` is a sibling of `app/`.

## Workflows

### `ci.yml` — every PR + push to `main`

| Job | Runner | Gates merge? | What it runs |
|---|---|---|---|
| `lint` | ubuntu | **yes** | `yarn lint` — ESLint |
| `typecheck` | ubuntu | **yes** | `yarn typecheck` — tsc --noEmit |
| `unit` | ubuntu | **yes** | `yarn db:schema:check`, then `yarn test:coverage` |
| `windows-spawn` | windows | **yes** | Windows-only spawn tests (cmd.exe shim) |
| `linux-spawn` | ubuntu | **yes** | Linux-only spawn tests (POSIX shim) |
| `sidecar` | ubuntu | **yes** | `pytest` + `ruff check` |
| `e2e` | ubuntu | no | Playwright e2e; **skipped unless the browser-use fork is configured** |

The `sidecar` job deliberately does **not** use `uv sync`. `sidecar/pyproject.toml`
declares `[tool.uv.sources] browser-use = { path = "../../browser-use" }`, which
resolves outside the repository, so `uv sync --frozen` fails in CI with the
opaque `Failed to determine installation plan`. The tests are written for
exactly this situation — `tests/test_recovery.py` states *"browser-use is not
importable in a bare test environment"* and stubs it — so CI installs
`pytest`/`pytest-asyncio`/`ruff` directly and runs `python -m pytest`. pytest
reads `[tool.pytest.ini_options]` (`pythonpath = src`, `asyncio_mode = auto`)
from `pyproject.toml` automatically.

### Coverage thresholds are a regression gate

`app/app/vitest.config.ts` pins thresholds just under the measured baseline
(lines 39, functions 38, branches 33, statements 37). The job fails if coverage
*drops* and passes when it rises. Do not raise these numbers on their own —
they were originally guessed at 60/60/50/60 without ever being measured, which
made the job permanently red and taught everyone to ignore it. Raise them only
in a commit that also adds the tests.

### The browser-use gate

`yarn package` runs a forge `prePackage` hook that stages the agent runtime
from the browser-use fork. With no `MYPILOT_BROWSER_USE_SRC` override,
`scripts/stage-sidecar-resources.mjs` resolves that fork as
`<product>/../browser-use`, a sibling of the checkout, and hard-fails with
`missing required source .../browser-use/pyproject.toml` when it is absent.

The fork is private, so it is wired in through the **`BROWSER_USE_FORK_URL`
repository variable**. Until that variable is set, `e2e` skips with an explicit
notice instead of failing on a missing third-party checkout. Setting the
variable enables the job with no further edits.

### `release.yml` — tag-driven GitHub Release

- `release-metadata` resolves the tag and previous release
- `make` — macOS: signs/notarizes per signing mode, builds DMG
- `make-windows` — builds the Squirrel installer
- `make-linux` — builds `.deb`/`.rpm`/AppImage in Docker

All three packaging jobs check out the browser-use fork. The location differs
deliberately:

- **macOS / Windows** run forge on the runner, so the fork goes *beside* the
  checkout at `$(dirname "$GITHUB_WORKSPACE")/browser-use`, which is what the
  stager resolves by default.
- **Linux** builds inside Docker. `app/scripts/build-linux-docker.sh` passes the
  repository root as the build context (so `sidecar/` and `browser-use/` are
  both visible) and preflights `$BUILD_CONTEXT/browser-use/pyproject.toml`, so
  the fork goes *inside* the checkout at `$GITHUB_WORKSPACE/browser-use`.

The Linux container mirrors the repository layout — forge runs from
`/workspace/app/app`, because that is where `forge.config.ts`, the vite
configs and `src/` actually are. `.dockerignore` must therefore sit at the
repository root; Docker reads only `./.dockerignore` from the context root, so
a copy under `app/` is silently ignored.

---

## Local Development

```bash
# Install dependencies
cd app/app
yarn install

yarn lint
yarn typecheck
yarn test
yarn e2e
yarn make

# Sidecar tests
cd ../../sidecar
uv sync --frozen          # needs the browser-use fork at ../../browser-use
uv run pytest tests/ -v
uv run ruff check src/ tests/
```

### Linux packaging needs Docker and the fork

```bash
git clone --depth 1 <fork-url> ../browser-use
cd app/scripts
bash build-linux-docker.sh
```

The script refuses to start with a clear message if the build context is
missing `sidecar/pyproject.toml` or `browser-use/pyproject.toml`.