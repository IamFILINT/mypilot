"""Tests for the self-healing run supervisor.

browser-use is not importable in a bare test environment, so the supervisor is
exercised through injected fakes: it takes callables for building the agent and
browser, reading usage, and probing, and has no intra-package imports.
"""

from __future__ import annotations

from typing import Any

import pytest

from bu_sidecar.recovery import (
    COST_KEY,
    RunOutcome,
    accumulate_usage,
    attempt_cost,
    browser_endpoint,
    close_browser,
    new_usage,
    probe_browser,
    run_succeeded,
    run_with_recovery,
    usage_to_payload,
)

# ── fakes ────────────────────────────────────────────────────────────────────


class FakeBrowser:
    def __init__(self, cdp_url: str | None = "http://127.0.0.1:9222") -> None:
        self.cdp_url = cdp_url
        self.closed = False

    async def stop(self) -> None:
        self.closed = True


class FakeUsage:
    def __init__(self, total_cost: float = 0.0) -> None:
        self.total_cost = total_cost


class FakeHistory:
    def __init__(self, *, done: bool, cost: float = 0.0) -> None:
        self._done = done
        self.usage = FakeUsage(cost)

    def is_done(self) -> bool:
        return self._done

    def final_result(self) -> str:
        return "result"

    def urls(self) -> list[str]:
        return []

    def number_of_steps(self) -> int:
        return 1

    def errors(self) -> list[str]:
        return []


class FakeAgent:
    def __init__(
        self, *, totals: dict[str, int], outcome: Any, model: str = "gpt-4.1-mini"
    ) -> None:
        self.totals = totals
        self.outcome = outcome
        self.model = model
        self.state = f"state-{id(self)}"
        self.max_steps_seen: int | None = None

    async def run(self, max_steps: int) -> Any:
        self.max_steps_seen = max_steps
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


def make_read_totals(agent_totals: dict[int, dict[str, int]]):  # type: ignore[no-untyped-def]
    def read(agent: FakeAgent) -> tuple[dict[str, int], str]:
        key = id(agent)
        return dict(agent_totals.get(key, {"prompt": 0, "completion": 0, "cached": 0})), agent.model

    return read


# ── probe ────────────────────────────────────────────────────────────────────


class _Response:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


class _Client:
    def __init__(self, result: Any) -> None:
        self._result = result
        self.closed = False

    async def get(self, url: str) -> Any:
        if isinstance(self._result, BaseException):
            raise self._result
        return _Response(self._result)

    async def aclose(self) -> None:
        self.closed = True


async def test_probe_succeeds_only_on_http_200() -> None:
    assert await probe_browser("http://127.0.0.1:9222", client=_Client(200)) is True
    assert await probe_browser("http://127.0.0.1:9222", client=_Client(500)) is False
    assert await probe_browser("http://127.0.0.1:9222", client=_Client(404)) is False


async def test_probe_treats_connection_error_as_dead() -> None:
    assert await probe_browser("http://127.0.0.1:9222", client=_Client(OSError("refused"))) is False


async def test_probe_rejects_missing_endpoint() -> None:
    assert await probe_browser(None, client=_Client(200)) is False
    assert await probe_browser("", client=_Client(200)) is False


async def test_probe_normalizes_websocket_endpoint() -> None:
    seen: list[str] = []

    class Recorder(_Client):
        async def get(self, url: str) -> Any:
            seen.append(url)
            return _Response(200)

    assert (
        await probe_browser("ws://127.0.0.1:9222/devtools/browser/x", client=Recorder(200)) is True
    )
    assert seen == ["http://127.0.0.1:9222/devtools/browser/x/json/version"]


async def test_probe_closes_client_it_owns_only_when_injected_client_absent() -> None:
    injected = _Client(200)
    await probe_browser("http://127.0.0.1:1", client=injected)
    assert injected.closed is False


# ── endpoint + teardown ──────────────────────────────────────────────────────


def test_browser_endpoint_reads_cdp_url() -> None:
    assert browser_endpoint(FakeBrowser()) == "http://127.0.0.1:9222"
    assert browser_endpoint(FakeBrowser(cdp_url=None)) is None
    assert browser_endpoint(object()) is None


async def test_close_browser_uses_stop_and_swallows_errors() -> None:
    browser = FakeBrowser()
    await close_browser(browser)
    assert browser.closed is True

    class Broken:
        async def stop(self) -> None:
            raise RuntimeError("already dead")

    await close_browser(Broken())
    await close_browser(None)


# ── usage accumulation ───────────────────────────────────────────────────────


def test_accumulate_usage_sums_across_attempts() -> None:
    cumulative = new_usage()
    accumulate_usage(cumulative, {"prompt": 100, "completion": 40, "cached": 10}, cost=0.5)
    accumulate_usage(cumulative, {"prompt": 60, "completion": 20, "cached": 5}, cost=0.25)
    payload = usage_to_payload(cumulative, "gpt-4.1-mini")
    assert payload["input_tokens"] == 160
    assert payload["output_tokens"] == 60
    assert payload["total_tokens"] == 220
    assert payload["cost_usd"] == 0.75
    assert payload["model"] == "gpt-4.1-mini"


def test_accumulate_usage_never_goes_negative() -> None:
    cumulative = new_usage()
    accumulate_usage(cumulative, {"prompt": 10, "completion": 5, "cached": 0})
    accumulate_usage(cumulative, None)
    assert cumulative["prompt"] == 10


def test_attempt_cost_reads_usage_summary() -> None:
    assert attempt_cost(FakeHistory(done=True, cost=1.25)) == 1.25
    assert attempt_cost(object()) == 0.0
    assert attempt_cost(FakeHistory(done=True, cost=0)) == 0.0


def test_run_succeeded_uses_history_completion() -> None:
    assert run_succeeded(FakeHistory(done=True)) is True
    assert run_succeeded(FakeHistory(done=False)) is False
    assert run_succeeded(object()) is False


# ── the supervisor ───────────────────────────────────────────────────────────


def _harness(agents: list[FakeAgent], probe_results: list[bool], events: list[dict]):  # type: ignore[no-untyped-def]
    """Build callables for run_with_recovery over a scripted sequence."""
    browsers: list[FakeBrowser] = []
    seen_states: list[Any] = []

    def build_browser() -> FakeBrowser:
        browser = FakeBrowser()
        browsers.append(browser)
        return browser

    def make_agent(browser: Any, prior_state: Any) -> FakeAgent:
        seen_states.append(prior_state)
        return agents[len(browsers) - 1]

    probe_calls: list[str | None] = []

    async def probe(cdp_url: str | None) -> bool:
        probe_calls.append(cdp_url)
        idx = min(len(probe_calls) - 1, len(probe_results) - 1)
        return probe_results[idx]

    return build_browser, make_agent, probe, browsers, seen_states, probe_calls


async def test_successful_run_does_not_probe_or_relaunch() -> None:
    agent = FakeAgent(
        totals={"prompt": 100, "completion": 20, "cached": 0}, outcome=FakeHistory(done=True)
    )
    build_browser, make_agent, probe, browsers, states, calls = _harness([agent], [True], [])
    events: list[dict] = []

    outcome = await run_with_recovery(
        make_agent=make_agent,
        build_browser=build_browser,
        read_totals=make_read_totals({id(agent): agent.totals}),
        emit=events.append,
        probe=probe,
    )

    assert isinstance(outcome, RunOutcome)
    assert outcome.attempts == 1
    assert outcome.usage["prompt"] == 100
    assert calls == []  # no health probe needed when the task completed
    assert events == []


async def test_dead_browser_after_unfinished_run_triggers_one_relaunch() -> None:
    first = FakeAgent(
        totals={"prompt": 100, "completion": 10, "cached": 0}, outcome=FakeHistory(done=False)
    )
    second = FakeAgent(
        totals={"prompt": 50, "completion": 5, "cached": 0},
        outcome=FakeHistory(done=True, cost=0.2),
    )
    build_browser, make_agent, probe, browsers, states, _calls = _harness(
        [first, second], [False, True], []
    )
    events: list[dict] = []

    outcome = await run_with_recovery(
        make_agent=make_agent,
        build_browser=build_browser,
        read_totals=make_read_totals({id(first): first.totals, id(second): second.totals}),
        emit=events.append,
        probe=probe,
    )

    assert outcome.attempts == 2
    # Usage is cumulative across attempts, so the desktop's residual math holds.
    assert outcome.usage_payload["input_tokens"] == 150
    assert outcome.usage_payload["output_tokens"] == 15
    assert outcome.usage_payload["cost_usd"] == 0.2
    # The second attempt inherits the first attempt's agent state.
    assert states[0] is None
    assert states[1] == first.state
    # The dead browser was torn down before the relaunch.
    assert browsers[0].closed is True
    assert any(e["type"] == "recovering" and e["relaunch"] for e in events)


async def test_live_browser_after_unfinished_run_is_left_to_upstream() -> None:
    agent = FakeAgent(
        totals={"prompt": 10, "completion": 1, "cached": 0}, outcome=FakeHistory(done=False)
    )
    build_browser, make_agent, probe, browsers, _states, _calls = _harness([agent], [True], [])
    events: list[dict] = []

    outcome = await run_with_recovery(
        make_agent=make_agent,
        build_browser=build_browser,
        read_totals=make_read_totals({id(agent): agent.totals}),
        emit=events.append,
        probe=probe,
    )

    # A transient fault is browser-use's job; we neither relaunch nor close.
    assert outcome.attempts == 1
    assert browsers[0].closed is False
    assert events == []



async def test_failed_attempt_cost_is_counted_before_relaunch() -> None:
    first = FakeAgent(
        totals={"prompt": 100, "completion": 10, "cached": 0},
        outcome=RuntimeError("browser died"),
    )
    second = FakeAgent(
        totals={"prompt": 50, "completion": 5, "cached": 0},
        outcome=FakeHistory(done=True, cost=0.2),
    )
    # Give the fake first attempt a token-cost service with an async summary.
    class CostService:
        async def get_usage_summary(self) -> Any:
            return type("Summary", (), {"total_cost": 0.75})()

    first.token_cost_service = CostService()
    build_browser, make_agent, probe, _browsers, _states, _calls = _harness(
        [first, second], [False, True], []
    )
    events: list[dict] = []

    outcome = await run_with_recovery(
        make_agent=make_agent,
        build_browser=build_browser,
        read_totals=make_read_totals({id(first): first.totals, id(second): second.totals}),
        emit=events.append,
        probe=probe,
    )

    assert outcome.attempts == 2
    assert outcome.usage_payload["cost_usd"] == 0.95

async def test_relaunch_budget_is_bounded() -> None:
    agents = [
        FakeAgent(
            totals={"prompt": 1, "completion": 0, "cached": 0}, outcome=FakeHistory(done=False)
        )
        for _ in range(4)
    ]
    build_browser, make_agent, probe, browsers, _states, _calls = _harness(agents, [False], [])
    events: list[dict] = []

    outcome = await run_with_recovery(
        make_agent=make_agent,
        build_browser=build_browser,
        read_totals=make_read_totals({id(a): a.totals for a in agents}),
        emit=events.append,
        probe=probe,
        max_relaunches=1,
    )

    # One initial attempt plus one relaunch, then it stops trying.
    assert outcome.attempts == 2
    assert len(browsers) == 2
    assert any(e.get("reason") == "budget_exhausted" for e in events)


async def test_raised_error_with_dead_browser_relaunches() -> None:
    first = FakeAgent(
        totals={"prompt": 30, "completion": 3, "cached": 0}, outcome=RuntimeError("Target closed")
    )
    second = FakeAgent(
        totals={"prompt": 7, "completion": 1, "cached": 0}, outcome=FakeHistory(done=True)
    )
    build_browser, make_agent, probe, browsers, _states, _calls = _harness(
        [first, second], [False, True], []
    )
    events: list[dict] = []

    outcome = await run_with_recovery(
        make_agent=make_agent,
        build_browser=build_browser,
        read_totals=make_read_totals({id(first): first.totals, id(second): second.totals}),
        emit=events.append,
        probe=probe,
    )

    assert outcome.attempts == 2
    assert outcome.usage_payload["input_tokens"] == 37
    assert browsers[0].closed is True
    assert any(e["type"] == "recovering" and e["reason"] == "browser_unavailable" for e in events)


async def test_raised_error_with_live_browser_is_reraised() -> None:
    agent = FakeAgent(
        totals={"prompt": 30, "completion": 3, "cached": 0}, outcome=RuntimeError("model timeout")
    )
    build_browser, make_agent, probe, browsers, _states, _calls = _harness([agent], [True], [])

    with pytest.raises(RuntimeError, match="model timeout"):
        await run_with_recovery(
            make_agent=make_agent,
            build_browser=build_browser,
            read_totals=make_read_totals({id(agent): agent.totals}),
            probe=probe,
        )

    assert browsers[0].closed is False


async def test_raised_error_is_reraised_when_budget_exhausted() -> None:
    agent = FakeAgent(
        totals={"prompt": 5, "completion": 0, "cached": 0}, outcome=RuntimeError("Target closed")
    )
    build_browser, make_agent, probe, browsers, _states, _calls = _harness([agent], [False], [])

    with pytest.raises(RuntimeError, match="Target closed"):
        await run_with_recovery(
            make_agent=make_agent,
            build_browser=build_browser,
            read_totals=make_read_totals({id(agent): agent.totals}),
            probe=probe,
            max_relaunches=0,
        )

    assert browsers[0].closed is False


async def test_max_steps_is_passed_through() -> None:
    agent = FakeAgent(
        totals={"prompt": 1, "completion": 0, "cached": 0}, outcome=FakeHistory(done=True)
    )
    build_browser, make_agent, probe, browsers, _states, _calls = _harness([agent], [True], [])

    await run_with_recovery(
        make_agent=make_agent,
        build_browser=build_browser,
        read_totals=make_read_totals({id(agent): agent.totals}),
        probe=probe,
        max_steps=17,
    )

    assert agent.max_steps_seen == 17


async def test_on_attempt_ready_runs_for_every_attempt() -> None:
    first = FakeAgent(
        totals={"prompt": 1, "completion": 0, "cached": 0}, outcome=FakeHistory(done=False)
    )
    second = FakeAgent(
        totals={"prompt": 1, "completion": 0, "cached": 0}, outcome=FakeHistory(done=True)
    )
    build_browser, make_agent, probe, browsers, _states, _calls = _harness(
        [first, second], [False, True], []
    )
    seen: list[tuple[Any, Any]] = []

    await run_with_recovery(
        make_agent=make_agent,
        build_browser=build_browser,
        on_attempt_ready=lambda a, b: seen.append((a, b)),
        read_totals=make_read_totals({id(first): first.totals, id(second): second.totals}),
        probe=probe,
    )

    assert seen == [(first, browsers[0]), (second, browsers[1])]


def test_cost_key_is_part_of_the_accumulator() -> None:
    assert COST_KEY in new_usage()



def test_distilled_skill_persists_in_profile_and_does_not_store_task_or_final(tmp_path) -> None:
    from bu_sidecar.skills import distill_skill

    task = "Open https://example.com/account?token=SECRET and use code 123456"
    final = "Done. The user's private account number is 4111111111111111"
    path = distill_skill(
        tmp_path,
        task,
        final,
        url="https://example.com/account?token=SECRET",
        action_names=["navigate", "click", "done"],
    )
    assert path == tmp_path / "skills" / "distilled" / "example.md"
    body = path.read_text(encoding="utf-8")
    assert "SECRET" not in body
    assert "123456" not in body
    assert "4111111111111111" not in body
    assert "example.com" in body
    assert "navigate" in body
