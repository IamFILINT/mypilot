/**
 * Quota gate for operator-metered engines.
 *
 * Precedence, per contract/openapi.yaml:
 *   1. The server verdict is authoritative. Plan limits, entitlements, and
 *      trial/expiry state are owned by the backend, so an operator can change
 *      them without shipping a client build.
 *   2. The local ledger is an offline fallback only. It is a display mirror and
 *      must never be the thing that grants access, because its limits live in
 *      client code a user can edit.
 *
 * The gateway remains the real enforcement point (per-token quota); this gate
 * exists so an over-quota user gets a clear message before spending a request.
 */

import { mainLogger } from '../logger';
import { evaluateQuota, usageLedger, type QuotaVerdict } from '../billing/usage';
import { AccountApiClient, AccountApiError, isApiOk } from './apiClient';
import { isSessionExpired, loadAccountSession } from './accountSession';

export type QuotaSource = 'server' | 'local-fallback' | 'local-nosession';

export interface QuotaDecision {
  allowed: boolean;
  message: string | null;
  verdict: QuotaVerdict;
  source: QuotaSource;
}

/** Adapt a server QuotaVerdict to the local shape the UI and logs expect. */
function toLocalVerdictShape(server: {
  allowed: boolean;
  message?: string | null;
  reason?: string | null;
  totals: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number; entries: number };
  plan: { id: string; monthlyTokenLimit: number; monthlyCostLimitUsd: number };
  periodStart: string;
  resetsAt: string;
  tokensUsed: number;
  tokensRemaining: number;
  costUsedUsd: number;
  costRemainingUsd: number;
}): QuotaVerdict {
  return {
    allowed: server.allowed,
    reason: (server.reason ?? undefined) as QuotaVerdict['reason'],
    message: server.message ?? null,
    totals: server.totals,
    plan: server.plan,
    periodStart: server.periodStart,
    resetsAt: server.resetsAt,
    tokensUsed: server.tokensUsed,
    tokensRemaining: server.tokensRemaining,
    costUsedUsd: server.costUsedUsd,
    costRemainingUsd: server.costRemainingUsd,
  };
}

function localDecision(source: QuotaSource): QuotaDecision {
  const verdict = usageLedger().checkQuota();
  return {
    allowed: verdict.allowed,
    message: verdict.message,
    verdict,
    source,
  };
}

/**
 * Decide whether a metered run may proceed.
 *
 * Never throws: a failure to reach the server degrades to the local mirror so
 * the app keeps working offline, and the reason is logged.
 */
export async function checkQuota(
  client: AccountApiClient = new AccountApiClient(),
): Promise<QuotaDecision> {
  const session = await loadAccountSession();
  if (!session || isSessionExpired(session)) {
    mainLogger.info('quota.gate.nosession', { source: 'local-nosession' });
    return localDecision('local-nosession');
  }

  const result = await client.quota(session.token);
  if (isApiOk(result)) {
    const verdict = toLocalVerdictShape(result.value);
    mainLogger.info('quota.gate.server', {
      allowed: verdict.allowed,
      reason: verdict.reason ?? null,
      planId: verdict.plan.id,
      tokensUsed: verdict.tokensUsed,
      tokensRemaining: verdict.tokensRemaining,
      costUsedUsd: verdict.costUsedUsd,
    });
    return { allowed: verdict.allowed, message: verdict.message, verdict, source: 'server' };
  }

  const error: AccountApiError = result.error;
  mainLogger.warn('quota.gate.serverFailed', {
    code: error.code,
    offline: error.offline,
    httpStatus: error.httpStatus ?? null,
  });

  // An explicit "not entitled" answer is authoritative even though it is an
  // error shape: never let a 401/402 become a local allow.
  if (!error.offline && (error.httpStatus === 401 || error.httpStatus === 402 || error.httpStatus === 403)) {
    return {
      allowed: false,
      message: error.message || 'Your account is not entitled to use the MyPilot Agent right now.',
      verdict: {
        ...usageLedger().checkQuota(),
        allowed: false,
        reason: undefined,
        message: error.message,
      },
      source: 'server',
    };
  }

  return localDecision('local-fallback');
}

export { evaluateQuota };
