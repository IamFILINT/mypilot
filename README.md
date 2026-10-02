# MyPilot

An AI browser agent for your desktop. You describe a task, it drives a real
Chromium, and you get the result back.

MyPilot is a fork of the [Browser Use desktop app](https://github.com/browser-use/desktop),
rebuilt as a fully open-source client you can read, run, and modify. There is no
proprietary agent logic in this repository — the agent itself is the upstream
[browser-use](https://github.com/browser-use/browser-use) library, and the whole
desktop layer around it is here for you to hack on.

If you want to contribute, issues and pull requests are welcome.

## Two ways to run it

**Bring your own key (BYOK).** If you already pay Anthropic, OpenAI, or another
provider, point MyPilot at your own account and you pay them directly. Nothing
is routed through us.

| Engine | Auth |
| --- | --- |
| **Claude Code** | Anthropic API key, or your Claude subscription |
| **Codex** | OpenAI API key, or your ChatGPT subscription |
| **BrowserCode** | Provider keys (Kimi, Qwen, MiniMax) |

**Pooled credits (optional).** The MyPilot Agent engine can also route every
model call through a managed gateway that pools providers and fails over between
them. If you'd rather not wire up provider keys, that's the path — and it means
someone else is paying for the tokens.

## Features

- **Persistent browser profiles** — logins survive between tasks, so an agent
  does not re-authenticate every run.
- **Self-healing runs.** If the browser process dies mid-task, MyPilot detects
  it with a real protocol probe, relaunches Chromium on the same profile, and
  re-plans with the agent's state intact. You see a notice instead of a hung
  window. See [`sidecar/src/bu_sidecar/recovery.py`](sidecar/src/bu_sidecar/recovery.py).
- **No Python required.** Release builds bundle a relocatable CPython and a
  prebuilt dependency tree, so the MyPilot Agent engine works on a clean
  machine.
- **Privacy defaults.** Telemetry is opt-in and off by default, favicons are
  fetched from each site's own origin rather than a third party, and logs are
  redacted so credentials, one-time codes, and task text never reach disk.
- **Bring up the phone.** WhatsApp can trigger a session by messaging
  `@MyPilot`.

## Status and contributing

Early days. Everything except the account backend is in this repository and
buildable today. Known gaps:

- The pooled-credits gateway and its account backend are not publicly hosted, so
  only the BYOK engines work out of the box. Everything else does.
- The MyPilot Agent engine runs its own headless browser. The interactive live
  view currently applies to the BYOK engines, not the MyPilot Agent.
- macOS builds are unsigned; you will need to right-click → Open on first launch.

Good first contributions: the live view for the MyPilot Agent engine, provider
and model catalogue cleanup, and translations. See
[`app/AGENTS.md`](app/AGENTS.md) for local development notes and
[`app/docs/`](app/docs/) for the agent-skill and CI references.

## Building from source

Requires **Node 20 or 22** and **yarn 1.x (classic)**.

> **Use yarn classic, not yarn 2+ / Berry.** The lockfile in this repo is
> yarn v1 format. Berry (yarn 4, which modern Node resolves via corepack) uses
> Plug'n'Play and cannot read it. If you have a newer yarn, either install
> classic with `npm i -g yarn@1.22.22`, or pin it per-project.

> **Pin the Node version.** `.nvmrc` and `.node-version` at the repo root
> request Node 22. Without that, a newer Node fails the `engines` check
> (`20.x || 22.x`) on `yarn install`.

Two errors that mean you skipped one of the above:

| Message | Cause | Fix |
|---|---|---|
| `The engine "node" is incompatible with this module` | Node 24+ | `nvm use` (picks up `.nvmrc`) |
| `.pnp.cjs` errors, or yarn can't parse `yarn.lock` | yarn 4 / Berry | `npm i -g yarn@1.22.22` |

```bash
git clone https://github.com/IamFILINT/mypilot.git
git clone https://github.com/browser-use/browser-use

cd mypilot/app/app
yarn install
yarn start
```

The `browser-use` checkout has to sit **beside** the `mypilot` directory, as
above. If you keep it anywhere else, point the build at it:

```bash
export MYPILOT_BROWSER_USE_SRC=/path/to/browser-use
```

Other useful commands:

```bash
yarn test        # unit tests
yarn typecheck   # tsc --noEmit
yarn lint        # eslint
yarn make        # build installers for the current platform
```

Packaging shells out to `uv` and a headless Chromium download, so a full
`yarn make` needs a network connection.

## Repository layout

```
app/        Electron + Vite desktop client
sidecar/    bu-sidecar — the Python agent wrapper, one task per invocation
```

The account API backend, the one-api gateway, and the browser-use library
checkout are separate and not part of this repository.

## Credits and licence

MyPilot is a derivative work of [browser-use/desktop](https://github.com/browser-use/desktop),
which is MIT licensed and copyright © 2024 Gregor Zunic. That notice is retained
in [`app/LICENSE`](app/LICENSE). The agent itself is
[browser-use](https://github.com/browser-use/browser-use), also MIT.

Built on [Browser Harness](https://github.com/browser-use/browser-harness).

## Licence

MIT
