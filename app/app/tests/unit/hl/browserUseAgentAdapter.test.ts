import { describe, expect, it } from 'vitest';
import type { EngineAdapter, ParseContext } from '../../../src/main/hl/engines/types';
import type { HlEvent } from '../../../src/shared/session-schemas';

const { get } = await import('../../../src/main/hl/engines/registry');
await import('../../../src/main/hl/engines/browser-use-agent/adapter');

function browserUseAdapter(): EngineAdapter {
  const adapter = get('browser-use-agent');
  if (!adapter) throw new Error('browser-use-agent adapter not registered');
  return adapter;
}

function parseContext(): ParseContext {
  return {
    iter: 0,
    pendingTools: new Map(),
    harnessHelpersPath: '/tmp/harness/helpers.js',
    harnessToolsPath: '/tmp/harness/TOOLS.json',
    harnessSkillPath: '/tmp/harness/skill.md',
  };
}

function stepLine(usage?: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'step',
    step: 1,
    url: 'https://example.com',
    evaluation_previous_goal: '',
    memory: 'On the example page',
    next_goal: 'Click the first result',
    actions: [{ click: { index: 1 } }],
    ...(usage ? { usage } : {}),
  });
}

function doneLine(usage?: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'done',
    summary: 'Clicked the first result.',
    steps: 2,
    urls: ['https://example.com'],
    errors: [],
    ...(usage ? { usage } : {}),
  });
}

function usageEvents(events: HlEvent[]): Array<Extract<HlEvent, { type: 'turn_usage' }>> {
  return events.filter((e): e is Extract<HlEvent, { type: 'turn_usage' }> => e.type === 'turn_usage');
}

describe('browser-use-agent per-step usage', () => {
  it('emits turn_usage from a step usage delta and accumulates it on the context', () => {
    const adapter = browserUseAdapter();
    const ctx = parseContext();

    const result = adapter.parseLine(
      stepLine({ input_tokens: 1200, output_tokens: 80, cached_input_tokens: 400, model: 'gpt-4.1-mini' }),
      ctx,
    );

    expect(usageEvents(result.events)).toEqual([
      {
        type: 'turn_usage',
        inputTokens: 1200,
        outputTokens: 80,
        cachedInputTokens: 400,
        costUsd: 0,
        model: 'gpt-4.1-mini',
        source: 'estimated',
      },
    ]);
    expect(ctx.usageEmitted).toEqual({ inputTokens: 1200, outputTokens: 80, cachedInputTokens: 400 });
    // step still surfaces narrative + tool events alongside usage
    expect(result.events.some((e) => e.type === 'thinking')).toBe(true);
    expect(result.events.some((e) => e.type === 'tool_call')).toBe(true);
  });

  it('emits only the residual on done so per-step totals are not double-counted', () => {
    const adapter = browserUseAdapter();
    const ctx = parseContext();

    adapter.parseLine(stepLine({ input_tokens: 1000, output_tokens: 50, cached_input_tokens: 100, model: 'gpt-4.1-mini' }), ctx);
    const done = adapter.parseLine(
      doneLine({ input_tokens: 1500, output_tokens: 70, total_tokens: 1570, cost_usd: 0.004 }),
      ctx,
    );

    expect(usageEvents(done.events)).toEqual([
      {
        type: 'turn_usage',
        inputTokens: 500,
        outputTokens: 20,
        cachedInputTokens: 0,
        costUsd: 0.004,
        source: 'estimated',
      },
    ]);
    expect(done.terminalDone).toBe(true);
  });

  it('keeps full done totals when the sidecar emitted no per-step usage (legacy)', () => {
    const adapter = browserUseAdapter();
    const ctx = parseContext();

    const done = adapter.parseLine(
      doneLine({ input_tokens: 1500, output_tokens: 70, total_tokens: 1570, cost_usd: 0.004 }),
      ctx,
    );

    expect(usageEvents(done.events)).toEqual([
      {
        type: 'turn_usage',
        inputTokens: 1500,
        outputTokens: 70,
        cachedInputTokens: 0,
        costUsd: 0.004,
        source: 'estimated',
      },
    ]);
  });

  it('skips turn_usage entirely when usage is absent or all-zero', () => {
    const adapter = browserUseAdapter();

    const step = adapter.parseLine(stepLine(), parseContext());
    expect(usageEvents(step.events)).toEqual([]);

    const zeroStep = adapter.parseLine(
      stepLine({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }),
      parseContext(),
    );
    expect(usageEvents(zeroStep.events)).toEqual([]);

    const zeroDone = adapter.parseLine(
      doneLine({ input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 }),
      parseContext(),
    );
    expect(usageEvents(zeroDone.events)).toEqual([]);
  });
});

describe('browser-use-agent self-healing events', () => {
  function line(value: Record<string, unknown>): string {
    return JSON.stringify(value);
  }

  it('surfaces a recovering notice so the run does not look hung', () => {
    const adapter = browserUseAdapter();
    const result = adapter.parseLine(
      line({ type: 'recovering', attempt: 1, reason: 'browser_unavailable', relaunch: true }),
      parseContext(),
    );

    const notices = result.events.filter(
      (e): e is Extract<HlEvent, { type: 'notify' }> => e.type === 'notify',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].level).toBe('info');
    expect(notices[0].message).toContain('recovering');
    expect(notices[0].message).toContain('browser unavailable');
    // Not terminal: the sidecar continues after a relaunch.
    expect(result.terminalDone).toBeFalsy();
    expect(result.terminalError).toBeUndefined();
  });

  it('surfaces a recovered notice', () => {
    const adapter = browserUseAdapter();
    const result = adapter.parseLine(
      line({ type: 'recovered', attempt: 2, relaunch: true }),
      parseContext(),
    );
    const notices = result.events.filter(
      (e): e is Extract<HlEvent, { type: 'notify' }> => e.type === 'notify',
    );
    expect(notices[0].message).toContain('recovered');
  });

  it('explains an exhausted retry budget', () => {
    const adapter = browserUseAdapter();
    const result = adapter.parseLine(
      line({ type: 'recovered', attempt: 2, relaunch: false, reason: 'budget_exhausted' }),
      parseContext(),
    );
    const notices = result.events.filter(
      (e): e is Extract<HlEvent, { type: 'notify' }> => e.type === 'notify',
    );
    expect(notices[0].message).toContain('could not be recovered');
  });

  it('maps a generic sidecar notify and preserves the blocking level', () => {
    const adapter = browserUseAdapter();
    const result = adapter.parseLine(
      line({ type: 'notify', message: 'Waiting for confirmation', level: 'blocking' }),
      parseContext(),
    );
    const notices = result.events.filter(
      (e): e is Extract<HlEvent, { type: 'notify' }> => e.type === 'notify',
    );
    expect(notices).toEqual([
      { type: 'notify', level: 'blocking', message: 'Waiting for confirmation' },
    ]);
  });

  it('ignores an empty notify rather than emitting a blank message', () => {
    const adapter = browserUseAdapter();
    const result = adapter.parseLine(line({ type: 'notify', level: 'info' }), parseContext());
    expect(result.events).toEqual([]);
  });

  it('does not crash on a recovery event with missing fields', () => {
    const adapter = browserUseAdapter();
    expect(() => adapter.parseLine(line({ type: 'recovering' }), parseContext())).not.toThrow();
    expect(() => adapter.parseLine(line({ type: 'recovered' }), parseContext())).not.toThrow();
  });

  it('keeps metering correct across a relaunch with cumulative done totals', () => {
    // Regression guard for the recovery/usage interaction: after a relaunch the
    // sidecar reports cumulative totals across attempts. If it reported only the
    // final attempt, the residual below would clamp to zero and every token
    // spent after the recovery would be dropped from the ledger.
    const adapter = browserUseAdapter();
    const ctx = parseContext();

    adapter.parseLine(
      line({ type: 'step', step: 1, url: 'https://a.example', actions: [], usage: { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 0, model: 'gpt-4.1-mini' } }),
      ctx,
    );
    adapter.parseLine(
      line({ type: 'recovering', attempt: 1, reason: 'browser_stopped', relaunch: true }),
      ctx,
    );
    // Second attempt: the sidecar's usage history restarts, so its step delta
    // is relative to that attempt only, and the client sums them.
    adapter.parseLine(
      line({ type: 'step', step: 1, url: 'https://b.example', actions: [], usage: { input_tokens: 400, output_tokens: 40, cached_input_tokens: 0, model: 'gpt-4.1-mini' } }),
      ctx,
    );

    // Cumulative across both attempts: 1400 in / 140 out.
    const done = adapter.parseLine(
      line({ type: 'done', summary: 'ok', steps: 2, usage: { input_tokens: 1400, output_tokens: 140, total_tokens: 1540, cost_usd: 0.01 } }),
      ctx,
    );

    expect(usageEvents(done.events)).toEqual([
      { type: 'turn_usage', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.01, source: 'estimated' },
    ]);
    // Total metered across the session equals the cumulative total, not a
    // single attempt's.
    expect(ctx.usageEmitted).toEqual({
      inputTokens: 1400,
      outputTokens: 140,
      cachedInputTokens: 0,
    });
  });
});
