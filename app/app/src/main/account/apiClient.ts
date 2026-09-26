/**
 * Typed client for the MyPilot Account API.
 *
 * Responses are validated with the zod schemas in src/shared/billingContract.ts
 * (which mirror contract/openapi.yaml) so a malformed or hostile response is
 * rejected rather than trusted. Errors are normalised into AccountApiError so
 * callers can distinguish "offline" from "not entitled" — the quota gate falls
 * back to the local ledger only for the former.
 */

import {
  AuthSessionResponseSchema,
  AuthStartResponseSchema,
  ErrorCodeSchema,
  ProvisionResponseSchema,
  QuotaVerdictSchema,
  UsageIngestResponseSchema,
  UsageSummaryResponseSchema,
  type AuthSessionResponse,
  type AuthStartResponse,
  type ProvisionResponse,
  type QuotaVerdict,
  type UsageIngestResponse,
  type UsageSummaryResponse,
} from '../../shared/billingContract';
import { accountApiBaseUrl, accountApiTimeoutMs } from './serviceConfig';

export class AccountApiError extends Error {
  readonly code: string;
  readonly httpStatus: number | undefined;
  /** True when the request never produced an HTTP response (offline/DNS/TLS). */
  readonly offline: boolean;

  constructor(
    message: string,
    opts: { code?: string; httpStatus?: number; offline?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AccountApiError';
    this.code = opts.code ?? 'upstream_unavailable';
    this.httpStatus = opts.httpStatus;
    this.offline = opts.offline ?? false;
  }
}

export type AccountApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AccountApiError };

/**
 * Explicit type guards.
 *
 * The app's tsconfig does not enable `strictNullChecks`, which disables
 * TypeScript's automatic narrowing of discriminated unions. These guards give
 * call sites real narrowing without turning on strict mode project-wide.
 */
export function isApiOk<T>(
  result: AccountApiResult<T>,
): result is { ok: true; value: T } {
  return result.ok;
}

export function isApiError<T>(
  result: AccountApiResult<T>,
): result is { ok: false; error: AccountApiError } {
  return !result.ok;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** Bearer session token. Omit for the unauthenticated auth endpoints. */
  token?: string | null;
  timeoutMs?: number;
}

function isOfflineError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // undici/fetch surfaces network failures as TypeError with a cause.
  if (err.name === 'TypeError') return true;
  const code = (err as { code?: string }).code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  );
}

export class AccountApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = options.baseUrl ?? accountApiBaseUrl();
    this.timeoutMs = options.timeoutMs ?? accountApiTimeoutMs();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(
    path: string,
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: unknown } },
    options: RequestOptions = {},
  ): Promise<AccountApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (options.token) headers.authorization = `Bearer ${options.token}`;

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      const text = await response.text();
      let payload: unknown = null;
      if (text.length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          return {
            ok: false,
            error: new AccountApiError('Account API returned a non-JSON response', {
              httpStatus: response.status,
            }),
          };
        }
      }

      if (!response.ok) {
        const body = payload as { error?: { code?: string; message?: string } } | null;
        const code = body?.error?.code;
        const parsedCode = code && ErrorCodeSchema.safeParse(code).success ? code : 'upstream_unavailable';
        return {
          ok: false,
          error: new AccountApiError(body?.error?.message ?? `Account API error ${response.status}`, {
            code: parsedCode,
            httpStatus: response.status,
          }),
        };
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return {
          ok: false,
          error: new AccountApiError('Account API response did not match the contract', {
            httpStatus: response.status,
          }),
        };
      }
      return { ok: true, value: parsed.data };
    } catch (err) {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        error: new AccountApiError(
          aborted ? 'Account API request timed out' : `Account API unreachable: ${(err as Error).message}`,
          { offline: !aborted || isOfflineError(err), cause: err },
        ),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Begin email OTP login. `devCode` is only present outside production. */
  startAuth(email: string): Promise<AccountApiResult<AuthStartResponse>> {
    return this.request('/v1/auth/start', AuthStartResponseSchema, {
      method: 'POST',
      body: { email },
    });
  }

  /** Exchange a one-time code for a session bearer token. */
  verifyAuth(pendingId: string, code: string): Promise<AccountApiResult<AuthSessionResponse>> {
    return this.request('/v1/auth/verify', AuthSessionResponseSchema, {
      method: 'POST',
      body: { pendingId, code },
    });
  }

  /** Revoke the current session. */
  logout(token: string): Promise<AccountApiResult<null>> {
    return this.request('/v1/auth/session', { safeParse: (v) => ({ success: true, data: null as null }) }, {
      method: 'DELETE',
      token,
    });
  }

  /** Fetch (or rotate) the router credentials for the signed-in account. */
  provision(token: string, rotate = false): Promise<AccountApiResult<ProvisionResponse>> {
    return this.request('/v1/provision', ProvisionResponseSchema, {
      method: 'POST',
      body: { rotate },
      token,
    });
  }

  /** Authoritative quota verdict for the current billing month. */
  quota(token: string): Promise<AccountApiResult<QuotaVerdict>> {
    return this.request('/v1/quota', QuotaVerdictSchema, { token });
  }

  /** Upload local usage-ledger entries (idempotent server-side). */
  ingestUsage(
    token: string,
    entries: unknown[],
  ): Promise<AccountApiResult<UsageIngestResponse>> {
    return this.request('/v1/usage/ingest', UsageIngestResponseSchema, {
      method: 'POST',
      body: { entries },
      token,
    });
  }

  /** Usage + plan summary for a billing month. */
  usageSummary(token: string, period?: string): Promise<AccountApiResult<UsageSummaryResponse>> {
    const query = period ? `?period=${encodeURIComponent(period)}` : '';
    return this.request(`/v1/usage/summary${query}`, UsageSummaryResponseSchema, { token });
  }
}
