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
