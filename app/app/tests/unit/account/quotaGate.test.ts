import { beforeEach, describe, expect, it, vi } from 'vitest';

const QUOTA_BODY = {
  allowed: true,
  totals: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, entries: 0 },
  plan: { id: 'pro', monthlyTokenLimit: 5_000_000, monthlyCostLimitUsd: 25 },
  periodStart: '2026-09-01',
  resetsAt: '2026-10-01',
  tokensUsed: 0,
  tokensRemaining: 5_000_000,
  costUsedUsd: 0,
  costRemainingUsd: 25,
};

const future = () => new Date(Date.now() + 86_400_000).toISOString();

async function loadGate() {
  return import('../../../src/main/account/quotaGate');
}


describe('quota gate', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('uses the server verdict when a session exists', async () => {
    const session = vi.fn(async () => ({
      token: 'tok',
      expiresAt: future(),
      account: { id: 'acc_1', email: 'a@example.com' },
    }));
    vi.doMock('../../../src/main/account/accountSession', () => ({
      loadAccountSession: session,
      isSessionExpired: () => false,
    }));
    const { checkQuota } = await loadGate();
    const client = { quota: vi.fn(async () => ({ ok: true, value: QUOTA_BODY })) } as never;

    const decision = await checkQuota(client);

    expect(decision.source).toBe('server');
    expect(decision.allowed).toBe(true);
    // The plan shown comes from the server, not the client fallback.
    expect(decision.verdict.plan.id).toBe('pro');
  });

  it('surfaces a server denial without consulting the local plan', async () => {
    vi.doMock('../../../src/main/account/accountSession', () => ({
      loadAccountSession: async () => ({
        token: 'tok',
        expiresAt: future(),
        account: { id: 'acc_1', email: 'a@example.com' },
      }),
      isSessionExpired: () => false,
    }));
    const { checkQuota } = await loadGate();
    const client = {
      quota: async () => ({
        ok: true,
        value: {
          ...QUOTA_BODY,
          allowed: false,
          reason: 'monthly_token_limit',
          message: 'Monthly pro limit reached.',
          tokensUsed: 5_000_000,
          tokensRemaining: 0,
        },
      }),
    } as never;

    const decision = await checkQuota(client);

    expect(decision.source).toBe('server');
    expect(decision.allowed).toBe(false);
    expect(decision.message).toBe('Monthly pro limit reached.');
    expect(decision.verdict.reason).toBe('monthly_token_limit');
  });

  it('falls back to the local ledger when signed out', async () => {
    vi.doMock('../../../src/main/account/accountSession', () => ({
      loadAccountSession: async (): Promise<null> => null,
      isSessionExpired: (): boolean => true,
    }));
    const { checkQuota } = await loadGate();

    const decision = await checkQuota({} as never);

    expect(decision.source).toBe('local-nosession');
    expect(decision.verdict.plan.id).toBe('free');
  });

  it('falls back to the local ledger when the server is unreachable', async () => {
    vi.doMock('../../../src/main/account/accountSession', () => ({
      loadAccountSession: async () => ({
        token: 'tok',
        expiresAt: future(),
        account: { id: 'acc_1', email: 'a@example.com' },
      }),
      isSessionExpired: () => false,
    }));
    const { checkQuota } = await loadGate();
    const client = {
      quota: async () => ({
        ok: false,
        error: { offline: true, code: 'upstream_unavailable', message: 'unreachable' },
      }),
    } as never;

    const decision = await checkQuota(client);

    expect(decision.source).toBe('local-fallback');
  });

  it('treats a 401/402/403 as an authoritative denial, not a fallback', async () => {
    vi.doMock('../../../src/main/account/accountSession', () => ({
      loadAccountSession: async () => ({
        token: 'tok',
        expiresAt: future(),
        account: { id: 'acc_1', email: 'a@example.com' },
      }),
      isSessionExpired: () => false,
    }));
    const { checkQuota } = await loadGate();
    const client = {
      quota: async () => ({
        ok: false,
        error: {
          offline: false,
          httpStatus: 402,
          code: 'quota_exceeded',
          message: 'Subscription required.',
        },
      }),
    } as never;

    const decision = await checkQuota(client);

    expect(decision.source).toBe('server');
    expect(decision.allowed).toBe(false);
    expect(decision.message).toBe('Subscription required.');
  });

  it('treats an expired session as signed out', async () => {
    vi.doMock('../../../src/main/account/accountSession', () => ({
      loadAccountSession: async () => ({
        token: 'tok',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        account: { id: 'acc_1', email: 'a@example.com' },
      }),
      isSessionExpired: () => true,
    }));
    const { checkQuota } = await loadGate();

    const decision = await checkQuota({} as never);

    expect(decision.source).toBe('local-nosession');
  });
});
