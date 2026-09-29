"""Self-healing supervisor for a MyPilot Agent run.

Why this exists
---------------
browser-use already heals the cheap failure: a dropped CDP WebSocket triggers an
automatic reconnect and the step is retried. What it does not do is survive the
browser *process* dying. When that happens ``Agent`` sets ``state.stopped`` and
the run ends, and previously the sidecar exited with a bare error.

``browser_harness.admin.ensure_daemon`` solves the same class of problem for the
CLI harness ("Idempotent. Self-heals stale daemon, closed Chrome, cold Chrome,
...") and contributes two ideas we adopt here:

1. Health is established with a **real protocol probe**, never process liveness.
   A daemon can accept connections while its CDP socket to Chrome is dead.
2. Recovery is **bounded and idempotent**, not a retry loop.

Deliberate scope
----------------
The sidecar runs one task per process against one local browser, so the
harness's daemon-specific concerns (stale daemons across tasks, duplicate-spawn
locks, billable cloud browsers, chrome://inspect approval) do not apply and are
not reimplemented.

On relaunch the agent is re-created with ``injected_agent_state`` so the file
system, failure counters, and other state carry over. browser-use 0.13.x cannot
continue a reasoning loop onto a new browser, so the agent *re-plans*; the
already-written artifacts and the profile's logins survive.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

log = logging.getLogger("bu_sidecar.recovery")

DEFAULT_PROBE_TIMEOUT_S = 2.0
DEFAULT_MAX_RELAUNCHES = 1
DEFAULT_CLOSE_TIMEOUT_S = 5.0
DEFAULT_RUN_TIMEOUT_S = 1800.0

# Token counters tracked cumulatively across attempts.
USAGE_KEYS = ("prompt", "completion", "cached")
# Cost is not derivable from usage_history, so it is accumulated separately from
# each attempt's AgentUsageSummary.
COST_KEY = "cost"


def _http_base(cdp_url: str | None) -> str | None:
    """Normalize a CDP endpoint to an http(s) base for the probe.

    playwright reports ``cdp_url`` as http, but be tolerant of the ws form so a
    future change of the upstream field does not silently disable healing.
    """
    if not cdp_url:
        return None
    url = cdp_url.strip()
    if url.startswith("ws://"):
        url = "http://" + url[len("ws://") :]
    elif url.startswith("wss://"):
        url = "https://" + url[len("wss://") :]
    return url.rstrip("/") or None


async def probe_browser(
    cdp_url: str | None,
    *,
    timeout_s: float = DEFAULT_PROBE_TIMEOUT_S,
    client: Any | None = None,
) -> bool:
    """True only when Chrome actually answers on its debugging endpoint.

    ``/json/version`` is served by the browser process itself, so a hung socket,
    a crashed process, or a stale endpoint all fail here. Process liveness is
    deliberately not consulted.
    """
    base = _http_base(cdp_url)
    if not base:
        return False

    owns_client = client is None
    http = client or _make_http_client(timeout_s)
    try:
        response = await http.get(f"{base}/json/version")
        return response.status_code == 200
    except Exception:
        return False
    finally:
        if owns_client:
            await _aclose(http)


def _make_http_client(timeout_s: float) -> Any:
    import httpx

    return httpx.AsyncClient(timeout=timeout_s)


async def _aclose(http: Any) -> None:
    close = getattr(http, "aclose", None)
    if close is None:
        return
    try:
        await close()
    except Exception:
        pass


async def close_browser(browser: Any, *, timeout_s: float = DEFAULT_CLOSE_TIMEOUT_S) -> None:
    """Best-effort teardown of a dead browser.

    A wedged Chromium can keep the profile lock, which would make the relaunch
    fail, so this is bounded and never raises.
    """
    if browser is None:
        return
    for name in ("stop", "close", "kill"):
        candidate = getattr(browser, name, None)
        if not callable(candidate):
            continue
        try:
            result = candidate()
            if asyncio.iscoroutine(result):
                await asyncio.wait_for(result, timeout=timeout_s)
            return
        except Exception:
            continue
    log.debug("browser close: no usable teardown method")


def browser_endpoint(browser: Any) -> str | None:
    for attr in ("cdp_url",):
        try:
            value = getattr(browser, attr, None)
        except Exception:
            value = None
        if value:
            return str(value)
    return None


def new_usage() -> dict[str, float]:
    usage: dict[str, float] = {key: 0 for key in USAGE_KEYS}
    usage[COST_KEY] = 0.0
    return usage


def _delta(
    before: dict[str, int] | None,
    after: dict[str, int] | None,
) -> dict[str, int]:
    """Per-attempt token delta, safe against cumulative usage_history carryover.

    If ``injected_agent_state`` carries the token cost service across attempts,
    ``after`` already includes prior attempts' tokens. Subtracting ``before``
    yields only this attempt's spend.
    """
    b = before or {}
    a = after or {}
    return {key: max(0, int(a.get(key, 0) or 0) - int(b.get(key, 0) or 0)) for key in USAGE_KEYS}


def accumulate_usage(
    cumulative: dict[str, float],
    totals: dict[str, int] | None,
    cost: float = 0.0,
) -> dict[str, float]:
    """Add one attempt's tokens and cost into the cross-attempt cumulative.

    The desktop computes the final residual as ``total - already_emitted`` and
    clamps at zero, so ``done`` must report the grand total across attempts or
    every token spent after a relaunch is silently dropped.
    """
    for key in USAGE_KEYS:
        value = int((totals or {}).get(key, 0) or 0)
        cumulative[key] = max(0, int(cumulative.get(key, 0)) + value)
    try:
        cumulative[COST_KEY] = round(float(cumulative.get(COST_KEY, 0.0)) + float(cost or 0.0), 8)
    except (TypeError, ValueError):
        pass
    return cumulative


async def attempt_cost_from_agent(agent: Any) -> float:
    """Cost for an attempt even when Agent.run() raised."""
    try:
        summary = await agent.token_cost_service.get_usage_summary()
        return float(getattr(summary, "total_cost", 0.0) or 0.0)
    except Exception:
        return 0.0


def attempt_cost(history: Any) -> float:
    """Cost for one completed attempt, as reported by its usage summary."""
    usage = getattr(history, "usage", None)
    if usage is None:
        return 0.0
    try:
        return float(getattr(usage, "total_cost", 0.0) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def usage_to_payload(cumulative: dict[str, float], model: str = "") -> dict[str, Any]:
    prompt = int(cumulative.get("prompt", 0))
    completion = int(cumulative.get("completion", 0))
    return {
        "input_tokens": prompt,
        "output_tokens": completion,
        "total_tokens": prompt + completion,
        "cost_usd": round(float(cumulative.get(COST_KEY, 0.0)), 8),
        "model": model or "",
    }


def run_succeeded(history: Any) -> bool:
    """True when the agent reached its own completion, regardless of browser state.

    A finished task never needs a relaunch, even if the browser died during
    teardown.
    """
    try:
        return bool(history.is_done())
    except Exception:
        return False


class RunOutcome:
    """What the supervised run produced, plus cumulative usage across attempts."""

    def __init__(self, history: Any, usage: dict[str, float], model: str, attempts: int) -> None:
        self.history = history
        self.usage = usage
        self.model = model
        self.attempts = attempts

    @property
    def usage_payload(self) -> dict[str, Any]:
        return usage_to_payload(self.usage, self.model)


async def run_with_recovery(
    *,
    make_agent: Callable[..., Any],
    build_browser: Callable[[], Any],
    on_attempt_ready: Callable[[Any, Any], None] | None = None,
    read_totals: Callable[[Any], tuple[dict[str, int], str]] | None = None,
    emit: Callable[[dict[str, Any]], None] | None = None,
    max_relaunches: int = DEFAULT_MAX_RELAUNCHES,
    max_steps: int = 50,
    run_timeout_s: float = DEFAULT_RUN_TIMEOUT_S,
    probe: Callable[[str | None], Awaitable[bool]] | None = None,
) -> RunOutcome:
    """Run the agent, relaunching a dead browser within a bounded budget.

    ``make_agent(browser, prior_state)`` must build a fresh Agent for each
    attempt; ``prior_state`` is the previous attempt's ``agent.state`` or None
    on the first attempt. ``on_attempt_ready(agent, browser)`` is where callers
    attach event streams.
    """
    emit = emit or (lambda _payload: None)
    read_totals = read_totals or (lambda _agent: ({}, ""))
    probe = probe or probe_browser

    cumulative = new_usage()
    model = ""
    attempt = 0
    prior_state: Any = None

    while True:
        attempt += 1
        browser = build_browser()
        agent = make_agent(browser, prior_state)
        if on_attempt_ready is not None:
            on_attempt_ready(agent, browser)

        totals, attempt_model = read_totals(agent)
        history: Any = None
        try:
            history = await asyncio.wait_for(
                agent.run(max_steps=max_steps), timeout=run_timeout_s
            )
        except Exception as exc:
            prior_state = _agent_state(agent)
            after_totals, attempt_model = read_totals(agent)
            failed_cost = await attempt_cost_from_agent(agent)
            accumulate_usage(cumulative, _delta(totals, after_totals), failed_cost)
            if attempt_model:
                model = attempt_model

            alive = await probe(browser_endpoint(browser))
            if alive or attempt > max_relaunches:
                raise
            emit(
                {
                    "type": "recovering",
                    "attempt": attempt,
                    "reason": "browser_unavailable",
                    "detail": f"{type(exc).__name__}: {exc}"[:400],
                    "relaunch": True,
                }
            )
            await close_browser(browser)
            continue

        prior_state = _agent_state(agent)
        after_totals, attempt_model = read_totals(agent)
        accumulate_usage(cumulative, _delta(totals, after_totals), attempt_cost(history))
        if attempt_model:
            model = attempt_model

        # A finished task is done, whatever happened to the browser.
        if run_succeeded(history):
            return RunOutcome(history, cumulative, model, attempt)

        # The run ended without finishing. Only worth a relaunch if the browser
        # is genuinely gone; otherwise upstream is handling a transient fault.
        alive = await probe(browser_endpoint(browser))
        if alive:
            return RunOutcome(history, cumulative, model, attempt)

        if attempt > max_relaunches:
            emit(
                {
                    "type": "recovered",
                    "attempt": attempt,
                    "relaunch": False,
                    "reason": "budget_exhausted",
                }
            )
            return RunOutcome(history, cumulative, model, attempt)

        emit(
            {
                "type": "recovering",
                "attempt": attempt,
                "reason": "browser_stopped",
                "relaunch": True,
            }
        )
        await close_browser(browser)


def _agent_state(agent: Any) -> Any:
    """The Agent's serializable state, used to seed the next attempt."""
    return getattr(agent, "state", None)
