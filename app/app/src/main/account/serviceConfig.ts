/**
 * Where MyPilot's own services live.
 *
 * These are operator-controlled endpoints, so they are overridable at build or
 * run time (self-hosting, staging, regional routing) while defaulting to the
 * production host. Nothing secret belongs here — the gateway token is issued
 * per account by the backend and stored in the OS keychain.
 */

const DEFAULT_API_BASE_URL = 'https://api.mypilot.ir';

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** Base URL of the MyPilot Account API (BFF). */
export function accountApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MYPILOT_API_URL?.trim();
  if (!raw) return DEFAULT_API_BASE_URL;
  try {
    const url = new URL(raw);
    // Loopback is allowed so a local BFF can be exercised in development.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) {
      return normalizeBaseUrl(raw);
    }
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_API_BASE_URL;
}

/** Per-request timeout for account API calls. */
export function accountApiTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MYPILOT_API_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 8000;
}
