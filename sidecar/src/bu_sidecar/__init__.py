"""Browser-use agent sidecar.

Runs one agent task per invocation, emitting NDJSON events on stdout:
  {"type":"sidecar_ready"}                    - sidecar started
  {"type":"browser_launched","cdp_url":...}    - Chromium up, CDP endpoint known
  {"type":"step", ...}                        - one agent step
  {"type":"done", ...}                        - final result + usage
  {"type":"error", "message":...}             - terminal error

Config arrives via env vars (BU_*), never argv, so nothing sensitive
appears in process listings.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any

# Silence noisy libs before any import that may log on import.
os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
for _name in ("httpx", "cdp_use", "browser_use", "patchright"):
    logging.getLogger(_name).setLevel(logging.WARNING)

MAX_TEXT = 4000


def profile_dir() -> Path:
    return Path(env("BU_PROFILE_DIR", default="./profiles/default"))


def session_dir() -> Path:
    return Path(env("BU_SESSION_DIR", default="./sessions/current"))


def seed_skills_dir() -> Path | None:
    raw = env("BU_SEED_SKILLS_DIR")
    if not raw:
        return None
    p = Path(raw)
    return p if p.is_dir() else None


def task_url(task: str) -> str:
    """First http(s) URL mentioned in the task, if any."""
    m = re.search(r'(https?://[^\s\)\]>,;"]+)', task, flags=re.I)
    return m.group(1) if m else ""


def emit(obj: dict[str, Any]) -> None:
    """Write one NDJSON event to stdout and flush immediately."""
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, ValueError):
        sys.exit(0)


def env(name: str, *, default: str | None = None) -> str | None:
    val = os.environ.get(name)
    if val is None or val == "":
        return default
    return val


class SidecarError(Exception):
    pass


async def run() -> None:
    parser = argparse.ArgumentParser(prog="bu-sidecar")
    parser.add_argument("--task", help="Task text (or read from BU_TASK env / stdin)")
    args, _unknown = parser.parse_known_args()

    task = args.task or env("BU_TASK")
    if not task:
        task = sys.stdin.read().strip()
    if not task:
        raise SidecarError("missing_task")

    emit({"type": "sidecar_ready", "pid": os.getpid()})

    # Import after sidecar_ready so import failures surface as NDJSON
    # events instead of tracebacks the parent can't parse.
    try:
        from browser_use import Agent
    except Exception as exc:
        emit({"type": "error", "message": f"import_failed: {exc}"})
        return

    from .recovery import run_with_recovery
    from .skills import distill_skill, skill_payload_for_run

    llm = build_llm()
    skill_text = skill_payload_for_run(task, task_url(task), profile_dir(), seed_skills_dir())

    def _make_agent(browser: Any, prior_state: Any) -> Any:
        kwargs: dict[str, Any] = {"task": task, "llm": llm, "browser": browser}
        if skill_text:
            kwargs["extend_system_message"] = skill_text
        if prior_state is not None:
            # Carry the file system, failure counters, and the rest of the agent
            # state onto the new browser. browser-use cannot resume a reasoning
            # loop onto a different browser, so the agent re-plans; artifacts it
            # already wrote and the profile's logins survive.
            try:
                kwargs["injected_agent_state"] = prior_state
            except Exception:
                pass
        return Agent(**kwargs)

    def _on_attempt_ready(agent: Any, browser: Any) -> None:
        # Report the CDP endpoint as soon as the browser starts so the desktop
        # client can attach its embedded live view. Re-attached per attempt
        # because each attempt gets its own browser.
        async def _on_browser_start(_event: Any) -> None:
            try:
                if browser.cdp_url:
                    emit({"type": "browser_launched", "cdp_url": browser.cdp_url})
            except Exception:
                pass

        try:
            browser.event_bus.on("*", _on_browser_start)
        except Exception:
            pass

        # Fresh per attempt, so the step usage deltas stay relative to that
        # attempt's own LLM calls and the client can sum them across attempts.
        attach_step_stream(agent)

    max_relaunches = 1
    raw_relaunches = env("BU_MAX_RELAUNCHES")
    if raw_relaunches:
        try:
            max_relaunches = max(0, int(raw_relaunches))
        except ValueError:
            pass

    outcome = await run_with_recovery(
        make_agent=_make_agent,
        build_browser=build_browser,
        on_attempt_ready=_on_attempt_ready,
        read_totals=_usage_totals,
        emit=emit,
        max_relaunches=max_relaunches,
        max_steps=int(env("BU_MAX_STEPS", default="50")),
    )
    history = outcome.history

    # Cumulative across attempts: the desktop subtracts what it already metered
    # from these totals and clamps at zero, so a per-attempt total would drop
    # every token spent after a relaunch.
    usage_payload: dict[str, Any] = outcome.usage_payload

    final = history.final_result() or "(no result)"
    try:
        distill_skill(
            session_dir(),
            task,
            str(final),
            url=history.urls()[-1] if (history.urls() or []) and history.urls()[-1] else "",
            action_names=history.action_names() or [],
            was_successful=not (history.errors() or []),
        )
    except Exception:
        pass
    emit(
        {
            "type": "done",
            "summary": str(final)[:MAX_TEXT],
            "steps": history.number_of_steps(),
            "attempts": outcome.attempts,
            "usage": usage_payload,
            "urls": [str(u) for u in (history.urls() or []) if u][:50],
            "errors": [str(e) for e in (history.errors() or []) if e][:20],
        }
    )


def build_llm():
    """LLM pointed at the operator's one-api router (OpenAI-compatible).

    The user never sees a provider key: the sidecar only holds a router
    token scoped to their account, injected as BU_ROUTER_TOKEN.
    """
    from browser_use import ChatOpenAI

    token = env("BU_ROUTER_TOKEN")
    base_url = env("BU_ROUTER_URL")
    if not token:
        raise SidecarError("missing_router_token")
    if not base_url:
        raise SidecarError("missing_router_url")
    return ChatOpenAI(
        model=env("BU_MODEL", default="gpt-4.1-mini"),
        api_key=token,
        base_url=base_url,
    )


def build_browser() -> Any:
    """Stealth Chromium subprocess per task via the v4 engine.

    - executable: patchright's patched Chromium when installed, else the
      engine falls back to its own managed Chromium.
    - user_data_dir: per-profile persistent dir so logins survive tasks
      (cloud-style profiles).
    - record_video_dir: per-session dir so every task ships a recording.
    """
    from browser_use import Browser

    prof_dir = profile_dir()
    sess_dir = session_dir()
    prof_dir.mkdir(parents=True, exist_ok=True)
    recordings = sess_dir / "recordings"
    recordings.mkdir(parents=True, exist_ok=True)

    kwargs: dict[str, Any] = {
        "headless": (env("BU_HEADLESS", default="true") or "true").lower() in ("1", "true", "yes"),
        "user_data_dir": str(prof_dir),
        "record_video_dir": str(recordings),
        "no_viewport": True,
    }
    executable = resolve_patchright_chromium()
    if executable:
        kwargs["executable_path"] = executable

    return Browser(**kwargs)


def _chrome_binary(root: Path) -> Path | None:
    """Chromium binary inside a playwright-style install dir.

    Handles the layouts playwright/patchright use per-OS:
      linux:   chrome-linux/chrome, chrome-linux64/chrome
      windows: chrome-win/chrome.exe, chrome-win64/chrome.exe
      macos:   chrome-mac/Google Chrome for Testing.app/Contents/MacOS/...
    """
    exe = ".exe" if sys.platform.startswith("win") else ""
    for rel in (
        Path("chrome-linux") / f"chrome{exe}",
        Path("chrome-linux64") / f"chrome{exe}",
        Path("chrome-win") / f"chrome{exe}",
        Path("chrome-win64") / f"chrome{exe}",
        Path("chrome-mac")
        / "Google Chrome for Testing.app"
        / "Contents"
        / "MacOS"
        / "Google Chrome for Testing",
        Path("chrome-mac") / "Chromium.app" / "Contents" / "MacOS" / "Chromium",
    ):
        candidate = root / rel
        if candidate.exists():
            return candidate
    return None


def _playwright_cache_dirs() -> list[Path]:
    """playwright/patchright browser cache dirs, per-OS, env override first."""
    home = Path.home()
    candidates: list[Path] = []
    override = env("PLAYWRIGHT_BROWSERS_PATH")
    if override:
        candidates.append(Path(override))
    candidates += [
        home / ".cache" / "ms-playwright",  # linux
        home / "Library" / "Caches" / "ms-playwright",  # macos
        home / "AppData" / "Local" / "ms-playwright",  # windows
    ]
    return [c for c in candidates if c.is_dir()]


def resolve_patchright_chromium() -> str | None:
    """Locate a stealth-patched Chromium, if installed.

    patchright stores browsers under ~/.cache/ms-playwright (same layout
    as playwright). BU_PATCHRIGHT_FIRST=false skips the patchright
    preference so the engine uses its own managed Chromium.
    """
    override = env("BU_CHROMIUM_PATH")
    if override:
        return override if Path(override).exists() else None

    prefer_patchright = (env("BU_PATCHRIGHT_FIRST", default="true") or "true").lower() in (
        "1",
        "true",
        "yes",
    )
    if not prefer_patchright:
        return None

    candidates: list[tuple[str, Path]] = []
    for cache in _playwright_cache_dirs():
        for install_dir in cache.glob("chromium-*"):
            binary = _chrome_binary(install_dir)
            if binary:
                candidates.append((install_dir.name, binary))
    if not candidates:
        return None
    # Highest revision number wins; prefer patchright's own dirs when
    # marked (patchright reuses the plain chromium-* names).
    candidates.sort(key=lambda c: c[0], reverse=True)
    return str(candidates[0][1])


def _usage_totals(agent: Any) -> tuple[dict[str, int], str]:
    """Cumulative token totals across every LLM call so far, plus the last
    model seen. browser-use accumulates each invocation in
    TokenCost.usage_history regardless of include_cost, so this works even
    when Agent.calculate_cost is off (cost is derived at done time).
    """
    totals = {"prompt": 0, "completion": 0, "cached": 0}
    model = ""
    try:
        entries = agent.token_cost_service.usage_history
    except Exception:
        return totals, model
    for entry in entries:
        u = getattr(entry, "usage", None)
        if u is None:
            continue
        totals["prompt"] += int(getattr(u, "prompt_tokens", 0) or 0)
        totals["completion"] += int(getattr(u, "completion_tokens", 0) or 0)
        totals["cached"] += int(getattr(u, "prompt_cached_tokens", 0) or 0)
        m = str(getattr(entry, "model", "") or "")
        if m:
            model = m
    return totals, model


def attach_step_stream(agent: Any) -> None:
    """Translate the agent's bubus EventBus into NDJSON step events.

    Each step also carries a `usage` delta (tokens since the previous step)
    so the desktop client can meter live instead of waiting for `done`.
    """
    from browser_use.agent.cloud_events import CreateAgentStepEvent

    last = {"prompt": 0, "completion": 0, "cached": 0}

    def _on_step(event: Any) -> None:
        try:
            payload: dict[str, Any] = {
                "type": "step",
                "step": getattr(event, "step", 0),
                "url": getattr(event, "url", ""),
                "evaluation_previous_goal": str(
                    getattr(event, "evaluation_previous_goal", "") or ""
                )[:MAX_TEXT],
                "memory": str(getattr(event, "memory", "") or "")[:MAX_TEXT],
                "next_goal": str(getattr(event, "next_goal", "") or "")[:MAX_TEXT],
                "actions": getattr(event, "actions", []),
            }
            screenshot = getattr(event, "screenshot_url", None)
            if screenshot:
                payload["screenshot"] = screenshot

            totals, model = _usage_totals(agent)
            delta = {k: max(0, totals[k] - last[k]) for k in totals}
            if any(delta.values()):
                last.update(totals)
                payload["usage"] = {
                    "input_tokens": delta["prompt"],
                    "output_tokens": delta["completion"],
                    "cached_input_tokens": delta["cached"],
                    "model": model or (env("BU_MODEL", default="") or ""),
                }

            emit(payload)
        except Exception:
            pass  # streaming must never kill the run

    agent.eventbus.on(CreateAgentStepEvent, _on_step)


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    except SidecarError as exc:
        emit({"type": "error", "message": str(exc)})
    except Exception as exc:
        emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
