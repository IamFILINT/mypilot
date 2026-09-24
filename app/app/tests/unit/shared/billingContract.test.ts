import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  AuthSessionResponseSchema,
  AuthStartRequestSchema,
  AuthStartResponseSchema,
  AuthVerifyRequestSchema,
  ProvisionResponseSchema,
  QuotaVerdictSchema,
  UsageIngestEntrySchema,
  UsageIngestRequestSchema,
  UsageSummaryResponseSchema,
  type UsageIngestEntry,
} from '../../../src/shared/billingContract';
import { UsageLedger, evaluateQuota, getLocalPlan } from '../../../src/main/billing/usage';

describe('billing contract parity with the local gate', () => {
  it('accepts the local Phase 4 quota verdict unchanged', () => {
    const now = new Date('2026-09-15T12:00:00.000Z');

    const under = evaluateQuota(
      { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, costUsd: 0.1, entries: 1 },
      getLocalPlan({}),
      now,
    );
    expect(() => QuotaVerdictSchema.parse(under)).not.toThrow();

    const blocked = evaluateQuota(
      { inputTokens: 5_000_000, outputTokens: 1, cachedInputTokens: 0, costUsd: 0, entries: 2 },
      getLocalPlan({}),
      now,
    );
    expect(blocked.allowed).toBe(false);
    const parsed = QuotaVerdictSchema.parse(blocked);
    expect(parsed.reason).toBe('monthly_token_limit');
    expect(parsed.message).toContain('resets on');
  });

  it('accepts a local usage-ledger entry as an ingest entry', () => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/billing-contract-${process.pid}`;
    const ledger = new UsageLedger(dir);
    ledger.record({
      ts: new Date('2026-09-15T12:00:00.000Z').toISOString(),
      sessionId: 'session-1',
      engine: 'browser-use-agent',
      model: 'gpt-4.1-mini',
      inputTokens: 1200,
      outputTokens: 80,
      cachedInputTokens: 400,
      costUsd: 0.004,
      source: 'estimated',
    });
    const [entry] = ledger.readAll();
    expect(() => UsageIngestEntrySchema.parse(entry)).not.toThrow();
    expect(() => UsageIngestRequestSchema.parse({ entries: [entry] })).not.toThrow();
  });
});

describe('billing contract shapes', () => {
  it('validates the auth flow payloads', () => {
    expect(() => AuthStartRequestSchema.parse({ email: 'user@example.com' })).not.toThrow();
    expect(() =>
      AuthStartResponseSchema.parse({
        pendingId: 'pend_123',
        expiresAt: '2026-09-15T12:10:00.000Z',
        devCode: '123456',
      }),
    ).not.toThrow();
    expect(() => AuthVerifyRequestSchema.parse({ pendingId: 'pend_123', code: '123456' })).not.toThrow();
    expect(AuthVerifyRequestSchema.safeParse({ pendingId: 'pend_123', code: 'abcdef' }).success).toBe(false);
    expect(() =>
      AuthSessionResponseSchema.parse({
        token: 'sess_abc',
        expiresAt: '2026-10-15T12:00:00.000Z',
        account: { id: 'acc_1', email: 'user@example.com' },
      }),
    ).not.toThrow();
  });

  it('validates provision and summary payloads', () => {
    expect(() =>
      ProvisionResponseSchema.parse({
        routerUrl: 'https://router.example.com',
        routerToken: 'sk-scoped-token',
        label: 'desktop-app',
        provisionedAt: '2026-09-15T12:00:00.000Z',
      }),
    ).not.toThrow();
    expect(ProvisionResponseSchema.safeParse({ routerUrl: 'not-a-url' }).success).toBe(false);

    const verdict = {
      allowed: true,
      totals: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, costUsd: 0.01, entries: 1 },
      plan: { id: 'free', monthlyTokenLimit: 2_000_000, monthlyCostLimitUsd: 10 },
      periodStart: '2026-09-01',
      resetsAt: '2026-10-01',
      tokensUsed: 12,
      tokensRemaining: 1_999_988,
      costUsedUsd: 0.01,
      costRemainingUsd: 9.99,
    };
    expect(() =>
      UsageSummaryResponseSchema.parse({
        period: '2026-09',
        totals: verdict.totals,
        plan: verdict.plan,
        verdict,
      }),
    ).not.toThrow();
    expect(UsageSummaryResponseSchema.safeParse({ period: '2026-13', ...verdict }).success).toBe(false);
  });

  it('enforces the 500-entry ingest batch limit', () => {
    const entry: UsageIngestEntry = {
    ts: '2026-09-15T12:00:00.000Z',
    sessionId: 's',
    engine: null,
    model: null,
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    costUsd: 0,
    source: 'estimated',
  };
    expect(UsageIngestRequestSchema.safeParse({ entries: [entry] }).success).toBe(true);
    expect(UsageIngestRequestSchema.safeParse({ entries: Array.from({ length: 500 }, () => entry) }).success).toBe(true);
    expect(UsageIngestRequestSchema.safeParse({ entries: Array.from({ length: 501 }, () => entry) }).success).toBe(false);
  });

  it('validates the error envelope', () => {
    expect(() =>
      ApiErrorSchema.parse({ error: { code: 'rate_limited', message: 'Too many attempts.' } }),
    ).not.toThrow();
    expect(ApiErrorSchema.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(false);
  });
});
