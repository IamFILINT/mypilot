import { describe, expect, it, vi } from 'vitest';
import {
  AccountApiClient,
  AccountApiError,
  isApiError,
  type AccountApiResult,
} from '../../../src/main/account/apiClient';

const BASE = 'https://api.test.invalid';

/** Narrows a failed result and returns its error, failing loudly otherwise. */
function expectFailure<T>(result: AccountApiResult<T>): AccountApiError {
  if (!isApiError(result)) throw new Error('expected the request to fail');
  return result.error;
}


function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const QUOTA_BODY = {
  allowed: true,
  totals: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, costUsd: 0.01, entries: 1 },
  plan: { id: 'free', monthlyTokenLimit: 1000, monthlyCostLimitUsd: 1 },
  periodStart: '2026-09-01',
  resetsAt: '2026-10-01',
  tokensUsed: 15,
  tokensRemaining: 985,
  costUsedUsd: 0.01,
  costRemainingUsd: 0.99,
};

describe('account api client', () => {
  it('sends the bearer token on authenticated calls', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(QUOTA_BODY));
    const client = new AccountApiClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.quota('tok-123');

    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/quota`);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('omits the authorization header when there is no session', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pendingId: 'p1', expiresAt: '2026-09-01T00:00:00Z' }));
    const client = new AccountApiClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.startAuth('a@example.com');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('rejects a response that does not match the contract', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ allowed: 'yes' }));
    const client = new AccountApiClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.quota('tok');
    expect(result.ok).toBe(false);
    expect(expectFailure(result).message).toContain('did not match the contract');
  });

  it('maps an API error body to its code and message', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'quota_exceeded', message: 'Limit reached' } }, 402),
    );
    const client = new AccountApiClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.quota('tok');
    expect(result.ok).toBe(false);
    const error = expectFailure(result);
    expect(error.code).toBe('quota_exceeded');
    expect(error.httpStatus).toBe(402);
    expect(error.offline).toBe(false);
    expect(error.message).toBe('Limit reached');
  });

  it('treats a network failure as offline', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    const client = new AccountApiClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.quota('tok');
    expect(result.ok).toBe(false);
    const error = expectFailure(result);
    expect(error.offline).toBe(true);
    expect(error).toBeInstanceOf(AccountApiError);
  });

  it('times out instead of hanging', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = new AccountApiClient({
      baseUrl: BASE,
      timeoutMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.quota('tok');
    expect(result.ok).toBe(false);
    expect(expectFailure(result).message).toMatch(/timed out|unreachable/);
  });

  it('rejects a non-JSON body', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>nope</html>', { status: 200 }));
    const client = new AccountApiClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.quota('tok');
    expect(result.ok).toBe(false);
    expect(expectFailure(result).message).toContain('non-JSON');
  });

  it('encodes the billing period on the summary endpoint', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ...QUOTA_BODY, period: '2026-09', verdict: QUOTA_BODY }),
    );
    const client = new AccountApiClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.usageSummary('tok', '2026-09');

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${BASE}/v1/usage/summary?period=2026-09`);
  });

  it('posts the rotate flag when rotating provisioning', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        routerUrl: 'https://api.test.invalid/v1',
        routerToken: 'sk-abc',
        label: 'MyPilot Desktop',
        provisionedAt: '2026-09-01T00:00:00Z',
      }),
    );
    const client = new AccountApiClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.provision('tok', true);
    expect(result.ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ rotate: true });
  });
});
