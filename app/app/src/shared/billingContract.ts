import { z } from 'zod';

// ---------------------------------------------------------------------------
// MyPilot Account API contract (mirrors product/contract/openapi.yaml).
//
// This is the client-side source of truth for the Phase 5 BFF: the desktop
// app validates responses with these schemas, and the BFF implements
// endpoints against the same shapes. `QuotaVerdictSchema` is deliberately
// identical to the local gate's verdict (src/main/billing/usage.ts) so the
// pre-spawn gate can consume either source interchangeably; a parity test
// asserts this.
// ---------------------------------------------------------------------------

// ── errors ──────────────────────────────────────────────────────────────────

export const ErrorCodeSchema = z.enum([
  'invalid_request',
  'invalid_credentials',
  'rate_limited',
  'quota_exceeded',
  'unauthorized',
  'upstream_unavailable',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ── auth ────────────────────────────────────────────────────────────────────

export const AccountSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
});
export type Account = z.infer<typeof AccountSchema>;

export const AuthStartRequestSchema = z.object({
  email: z.email(),
});
export type AuthStartRequest = z.infer<typeof AuthStartRequestSchema>;

export const AuthStartResponseSchema = z.object({
  pendingId: z.string().min(1),
  expiresAt: z.iso.datetime(),
  /** 6-digit code echoed only outside production (no mail provider configured). */
  devCode: z.string().regex(/^\d{6}$/).optional(),
});
export type AuthStartResponse = z.infer<typeof AuthStartResponseSchema>;

export const AuthVerifyRequestSchema = z.object({
  pendingId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
});
export type AuthVerifyRequest = z.infer<typeof AuthVerifyRequestSchema>;

export const AuthSessionResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  account: AccountSchema,
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

// ── provisioning ────────────────────────────────────────────────────────────

export const ProvisionRequestSchema = z.object({
  rotate: z.boolean().optional(),
});
export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>;

export const ProvisionResponseSchema = z.object({
  routerUrl: z.url(),
  routerToken: z.string().min(1),
  label: z.string().min(1),
  provisionedAt: z.iso.datetime(),
});
export type ProvisionResponse = z.infer<typeof ProvisionResponseSchema>;

// ── quota ───────────────────────────────────────────────────────────────────

export const PlanSchema = z.object({
  id: z.string().min(1),
  monthlyTokenLimit: z.number().int().nonnegative(),
  monthlyCostLimitUsd: z.number().nonnegative(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const UsageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Subset of inputTokens — never added on top when summing. */
  cachedInputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  entries: z.number().int().nonnegative(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const QuotaReasonSchema = z.enum(['monthly_token_limit', 'monthly_cost_limit']);
export type QuotaReason = z.infer<typeof QuotaReasonSchema>;

/** Identical shape to the local gate verdict (src/main/billing/usage.ts). */
export const QuotaVerdictSchema = z.object({
  allowed: z.boolean(),
  /** Present only when blocked. */
  reason: QuotaReasonSchema.optional(),
  /** User-facing explanation; present only when blocked. */
  message: z.string().optional(),
  totals: UsageTotalsSchema,
  plan: PlanSchema,
  /** 'YYYY-MM-DD' of the UTC billing period start. */
  periodStart: z.iso.date(),
  /** 'YYYY-MM-DD' the limit resets (UTC). */
  resetsAt: z.iso.date(),
  tokensUsed: z.number().int().nonnegative(),
  tokensRemaining: z.number().int().nonnegative(),
  costUsedUsd: z.number().nonnegative(),
  costRemainingUsd: z.number().nonnegative(),
});
export type QuotaVerdict = z.infer<typeof QuotaVerdictSchema>;

// ── usage ingest ────────────────────────────────────────────────────────────

export const UsageIngestEntrySchema = z.object({
  /** Optional client-generated idempotency key; absent ⇒ content-hash dedupe. */
  eventId: z.string().min(1).max(128).optional(),
  ts: z.iso.datetime(),
  sessionId: z.string().min(1),
  engine: z.string().nullable(),
  model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  source: z.enum(['exact', 'estimated']),
});
export type UsageIngestEntry = z.infer<typeof UsageIngestEntrySchema>;

export const UsageIngestRequestSchema = z.object({
  entries: z.array(UsageIngestEntrySchema).min(1).max(500),
});
export type UsageIngestRequest = z.infer<typeof UsageIngestRequestSchema>;

export const UsageIngestResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
});
export type UsageIngestResponse = z.infer<typeof UsageIngestResponseSchema>;

// ── usage summary (UI) ──────────────────────────────────────────────────────

export const BillingPeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export type BillingPeriod = z.infer<typeof BillingPeriodSchema>;

export const UsageSummaryResponseSchema = z.object({
  period: BillingPeriodSchema,
  totals: UsageTotalsSchema,
  plan: PlanSchema,
  verdict: QuotaVerdictSchema,
});
export type UsageSummaryResponse = z.infer<typeof UsageSummaryResponseSchema>;
