# MyPilot

An AI browser agent for your desktop. You describe a task, it drives a real
Chromium, and you get the result back.

MyPilot is a fork of the [Browser Use desktop app](https://github.com/browser-use/desktop),
rebranded and rebuilt around a different model: **the client is free and open
source, and the LLM credits you spend are the product.** There is no proprietary
agent logic in this repository — the agent itself is the upstream
[browser-use](https://github.com/browser-use/browser-use) library.

## Two ways to run it

**Bring your own key.** If you already pay Anthropic, OpenAI, or another
provider, point MyPilot at your own account and you pay them directly. Nothing
is routed through us.

| Engine | Auth |
| --- | --- |
| **Claude Code** | Anthropic API key, or your Claude subscription |
| **Codex** | OpenAI API key, or your ChatGPT subscription |
| **BrowserCode** | Provider keys (Kimi, Qwen, MiniMax) |

**MyPilot credits.** The MyPilot Agent engine sends every model call through our
own gateway, which pools providers, fails over between them, and meters usage
against your plan. You buy credits, not a key to paste.

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

## Status

This is an early release, built for the Iranian market. Known gaps:

- The MyPilot Agent engine runs its own headless browser. The interactive live
  view currently applies to the BYOK engines, not the MyPilot Agent.
- The gateway and account backend are not yet publicly hosted.
- macOS builds are unsigned; you will need to right-click → Open on first launch.

## Building from source

Requires Node 20 or 22, and `yarn`.

```bash
git clone https://github.com/IamFILINT/mypilot.git
cd mypilot/app
yarn install

# The agent engine builds against a checkout of the browser-use library.
git clone https://github.com/browser-use/browser-use ../browser-use

yarn start
```

If you keep the `browser-use` checkout somewhere else, point the build at it:

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
