/**
 * Local usage ledger + plan quota (Phase 4, local-first).
 *
 * Every turn_usage event the session runner rolls up is also appended to an
 * append-only JSONL file under userData (usage-ledger.jsonl). The pre-spawn
 * gate for operator-metered engines sums the current UTC month against the
 * local plan and blocks the spawn with a user-facing reset date when the
 * limit is reached. Phase 5 replaces the local plan with the cloud account's
 * server-side quota; the ledger stays as the local mirror for the UI.
 *
 * Crash safety: appends are single-line JSON; readers skip a partial last
 * line instead of failing the whole file. Recording never throws into the
 * session pipeline.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mainLogger } from '../logger';

const LEDGER_FILE_NAME = 'usage-ledger.jsonl';

export interface UsageEntry {
  /** ISO 8601 UTC timestamp of the turn_usage event. */
  ts: string;
  sessionId: string;
  engine: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  source: 'exact' | 'estimated';
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  entries: number;
}

export const EMPTY_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  costUsd: 0,
  entries: 0,
};

/** Billable tokens: cached input is a subset of input, never added twice. */
export function totalTokens(totals: Pick<UsageTotals, 'inputTokens' | 'outputTokens'>): number {
  return totals.inputTokens + totals.outputTokens;
}

export interface LocalPlan {
  id: string;
  monthlyTokenLimit: number;
  monthlyCostLimitUsd: number;
}

/**
 * Offline fallback plan.
 *
 * These numbers are NOT authoritative — the account API owns plan limits and
 * entitlements (see src/main/account/quotaGate.ts). They exist only so an
 * offline or signed-out user still gets a sane local stop instead of unlimited
 * local spend, and so the UI has something to render. A user can edit them;
 * that is acceptable precisely because the server and gateway still enforce the
 * real limit.
 */
const FALLBACK_PLAN: LocalPlan = {
  id: 'free',
  monthlyTokenLimit: 2_000_000,
  monthlyCostLimitUsd: 10,
};

/** Local fallback plan with env overrides (offline tuning / self-host). */
export function getLocalPlan(env: NodeJS.ProcessEnv = process.env): LocalPlan {
  const plan: LocalPlan = { ...FALLBACK_PLAN };
  const tokens = Number(env.BU_MONTHLY_TOKEN_LIMIT);
  if (Number.isFinite(tokens) && tokens > 0) plan.monthlyTokenLimit = Math.floor(tokens);
  const cost = Number(env.BU_MONTHLY_COST_LIMIT_USD);
  if (Number.isFinite(cost) && cost >= 0) plan.monthlyCostLimitUsd = cost;
  return plan;
}

/** Start of the UTC billing month containing `now`. */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Exclusive end of the UTC billing month containing `now` (= reset moment). */
export function utcMonthEnd(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export interface QuotaVerdict {
  allowed: boolean;
  reason?: 'monthly_token_limit' | 'monthly_cost_limit';
  /** User-facing explanation, set only when blocked. */
  message?: string;
  totals: UsageTotals;
  plan: LocalPlan;
  /** 'YYYY-MM-DD' of the billing period start. */
  periodStart: string;
  /** 'YYYY-MM-DD' the limit resets (UTC). */
  resetsAt: string;
  tokensUsed: number;
  tokensRemaining: number;
  costUsedUsd: number;
  costRemainingUsd: number;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function evaluateQuota(totals: UsageTotals, plan: LocalPlan, now: Date = new Date()): QuotaVerdict {
  const periodStart = utcMonthStart(now);
  const resetsAt = utcMonthEnd(now);
  const tokensUsed = totalTokens(totals);
  const tokensRemaining = Math.max(0, plan.monthlyTokenLimit - tokensUsed);
  const costUsedUsd = totals.costUsd;
  const costRemainingUsd = Math.max(0, plan.monthlyCostLimitUsd - costUsedUsd);

  const verdict: QuotaVerdict = {
    allowed: true,
    totals,
    plan,
    periodStart: ymd(periodStart),
    resetsAt: ymd(resetsAt),
    tokensUsed,
    tokensRemaining,
    costUsedUsd,
    costRemainingUsd,
  };

  if (tokensUsed >= plan.monthlyTokenLimit) {
    return {
      ...verdict,
      allowed: false,
      reason: 'monthly_token_limit',
      message: `Monthly usage limit reached (${tokensUsed.toLocaleString('en-US')} / ${plan.monthlyTokenLimit.toLocaleString('en-US')} tokens). Your plan resets on ${ymd(resetsAt)}.`,
    };
  }
  if (costUsedUsd >= plan.monthlyCostLimitUsd) {
    return {
      ...verdict,
      allowed: false,
      reason: 'monthly_cost_limit',
      message: `Monthly cost limit reached ($${costUsedUsd.toFixed(2)} / $${plan.monthlyCostLimitUsd.toFixed(2)}). Your plan resets on ${ymd(resetsAt)}.`,
    };
  }
  return verdict;
}

function resolveUserDataDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.getPath('userData');
  } catch {
    return path.join(os.tmpdir(), 'agentic-browser');
  }
}

export class UsageLedger {
  readonly filePath: string;

  constructor(dir?: string) {
    this.filePath = path.join(dir ?? resolveUserDataDir(), LEDGER_FILE_NAME);
  }

  /** Append one entry. Never throws — metering must not break the run. */
  record(entry: UsageEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      mainLogger.warn('UsageLedger.record.failed', {
        filePath: this.filePath,
        error: (err as Error).message,
      });
    }
  }

  readAll(): UsageEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        mainLogger.warn('UsageLedger.read.failed', {
          filePath: this.filePath,
          error: (err as Error).message,
        });
      }
      return [];
    }
    const out: UsageEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as UsageEntry);
      } catch {
        // Partial last line from a crash mid-append — skip it.
      }
    }
    return out;
  }

  /** Sum of all entries with ts >= since (inclusive). */
  totalsSince(since: Date): UsageTotals {
    const sinceMs = since.getTime();
    const totals: UsageTotals = { ...EMPTY_TOTALS };
    for (const e of this.readAll()) {
      const ts = Date.parse(e.ts);
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      totals.inputTokens += e.inputTokens || 0;
      totals.outputTokens += e.outputTokens || 0;
      totals.cachedInputTokens += e.cachedInputTokens || 0;
      totals.costUsd += e.costUsd || 0;
      totals.entries += 1;
    }
    return totals;
  }

  /** Current UTC billing-month totals. */
  monthlyTotals(now: Date = new Date()): UsageTotals {
    return this.totalsSince(utcMonthStart(now));
  }

  /** Ledger totals for this month checked against the local plan. */
  checkQuota(now: Date = new Date()): QuotaVerdict {
    return evaluateQuota(this.monthlyTotals(now), getLocalPlan(), now);
  }
}

let singleton: UsageLedger | null = null;

/** App-wide ledger instance (userData). Tests construct UsageLedger directly. */
export function usageLedger(): UsageLedger {
  singleton ??= new UsageLedger();
  return singleton;
}
