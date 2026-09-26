# MyPilot desktop client

The Electron client. See the [repository README](../README.md) for what MyPilot
is, how the two auth models work, and an honest note on current limitations.

## Development

Requires Node 20 or 22.

```bash
yarn install
yarn start        # electron-forge start
yarn test         # vitest
yarn typecheck    # tsc --noEmit
yarn lint         # eslint
```

Packaging needs `uv` on `PATH` and network access for the headless Chromium
download. `yarn make` runs the `prePackage` hook, which:

1. stages an allowlisted copy of the sidecar and the browser-use library into
   `.forge-stage/` — the dev trees also hold a local venv, real browser profiles,
   and upstream git history, none of which may ship;
2. generates `app-update.yml` from `src/shared/releaseChannel.ts`, failing the
   build if the release owner is unset or points at another repository;
3. builds the bundled Python runtime (`scripts/build-python-runtime.mjs`), which
   is platform-specific and therefore built in CI rather than committed. Set
   `MYPILOT_SKIP_RUNTIME=1` for a quick local package that falls back to system
   Python.

Source locations for the two external trees can be overridden with
`MYPILOT_SIDECAR_SRC`, `MYPILOT_BROWSER_USE_SRC`, and `MYPILOT_STAGE_DIR`.

See [`app/AGENTS.md`](AGENTS.md) for local profile and session-schema notes, and
[`app/docs/`](docs/) for the agent-skill and CI references.

## Licence

MIT — see [`LICENSE`](LICENSE), which retains the upstream Browser Use notice.
