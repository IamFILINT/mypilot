import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EMPTY_TOTALS,
  UsageLedger,
  evaluateQuota,
  getLocalPlan,
  totalTokens,
  utcMonthEnd,
  utcMonthStart,
  type UsageEntry,
} from '../../../src/main/billing/usage';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-'));
}

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    ts: new Date().toISOString(),
    sessionId: 'session-1',
    engine: 'browser-use-agent',
    model: 'gpt-4.1-mini',
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 10,
    costUsd: 0.01,
    source: 'estimated',
    ...over,
  };
}

describe('UsageLedger', () => {
  it('round-trips records and sums current-month totals', () => {
    const ledger = new UsageLedger(tempDir());
    ledger.record(entry({ inputTokens: 100, outputTokens: 20 }));
    ledger.record(entry({ sessionId: 'session-2', inputTokens: 50, outputTokens: 10, costUsd: 0.005 }));

    expect(ledger.readAll()).toHaveLength(2);
    const totals = ledger.monthlyTotals();
    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(30);
    expect(totals.cachedInputTokens).toBe(20);
    expect(totals.costUsd).toBeCloseTo(0.015, 10);
    expect(totals.entries).toBe(2);
  });

  it('excludes entries from previous billing months', () => {
    const ledger = new UsageLedger(tempDir());
    const now = new Date('2026-09-15T12:00:00.000Z');
    ledger.record(entry({ ts: '2026-08-31T23:59:59.000Z', inputTokens: 999, outputTokens: 999 }));
    ledger.record(entry({ ts: '2026-09-01T00:00:00.000Z', inputTokens: 10, outputTokens: 5 }));

    const totals = ledger.monthlyTotals(now);
    expect(totals.inputTokens).toBe(10);
    expect(totals.outputTokens).toBe(5);
    expect(totals.entries).toBe(1);
  });

  it('skips a partial trailing line from a crashed append', () => {
    const dir = tempDir();
    const ledger = new UsageLedger(dir);
    ledger.record(entry());
    fs.appendFileSync(ledger.filePath, '{"ts":"2026-09-15T00:00:00.000Z","inputTok', 'utf-8');

    expect(ledger.readAll()).toHaveLength(1);
    expect(ledger.monthlyTotals().inputTokens).toBe(100);
  });

  it('returns empty totals when the ledger file does not exist', () => {
    const ledger = new UsageLedger(tempDir());
    expect(ledger.readAll()).toEqual([]);
    expect(ledger.monthlyTotals()).toEqual(EMPTY_TOTALS);
  });
});

describe('getLocalPlan', () => {
  it('uses the baked-in free plan by default', () => {
    const plan = getLocalPlan({});
    expect(plan.id).toBe('free');
    expect(plan.monthlyTokenLimit).toBeGreaterThan(0);
    expect(plan.monthlyCostLimitUsd).toBeGreaterThan(0);
  });

  it('honors env overrides', () => {
    const plan = getLocalPlan({ BU_MONTHLY_TOKEN_LIMIT: '5000', BU_MONTHLY_COST_LIMIT_USD: '2.5' });
    expect(plan.monthlyTokenLimit).toBe(5000);
    expect(plan.monthlyCostLimitUsd).toBe(2.5);
  });

  it('ignores garbage env values', () => {
    const plan = getLocalPlan({ BU_MONTHLY_TOKEN_LIMIT: 'lots', BU_MONTHLY_COST_LIMIT_USD: '-1' });
    expect(plan.monthlyTokenLimit).toBe(getLocalPlan({}).monthlyTokenLimit);
    expect(plan.monthlyCostLimitUsd).toBe(getLocalPlan({}).monthlyCostLimitUsd);
  });
});

describe('evaluateQuota', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');

  it('allows usage under the limit and reports remaining', () => {
    const plan = { id: 'free', monthlyTokenLimit: 1000, monthlyCostLimitUsd: 5 };
    const verdict = evaluateQuota(
      { inputTokens: 300, outputTokens: 100, cachedInputTokens: 50, costUsd: 1.25, entries: 3 },
      plan,
      now,
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeUndefined();
    expect(verdict.tokensUsed).toBe(400);
    expect(verdict.tokensRemaining).toBe(600);
    expect(verdict.costRemainingUsd).toBeCloseTo(3.75, 10);
    expect(verdict.periodStart).toBe('2026-09-01');
    expect(verdict.resetsAt).toBe('2026-10-01');
  });

  it('blocks at the monthly token limit with a reset date', () => {
    const plan = { id: 'free', monthlyTokenLimit: 400, monthlyCostLimitUsd: 5 };
    const verdict = evaluateQuota(
      { inputTokens: 300, outputTokens: 100, cachedInputTokens: 0, costUsd: 1, entries: 2 },
      plan,
      now,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('monthly_token_limit');
    expect(verdict.message).toContain('400 / 400');
    expect(verdict.message).toContain('2026-10-01');
    expect(verdict.tokensRemaining).toBe(0);
  });

  it('blocks at the monthly cost limit', () => {
    const plan = { id: 'free', monthlyTokenLimit: 1_000_000, monthlyCostLimitUsd: 10 };
    const verdict = evaluateQuota(
      { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, costUsd: 10, entries: 1 },
      plan,
      now,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('monthly_cost_limit');
    expect(verdict.message).toContain('$10.00 / $10.00');
    expect(verdict.message).toContain('2026-10-01');
  });

  it('counts cached tokens as a subset of input, not additively', () => {
    expect(totalTokens({ inputTokens: 100, outputTokens: 20 })).toBe(120);
  });
});

describe('month boundaries', () => {
  it('computes UTC month start/end', () => {
    const now = new Date('2026-12-31T23:59:59.000Z');
    expect(utcMonthStart(now).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(utcMonthEnd(now).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
