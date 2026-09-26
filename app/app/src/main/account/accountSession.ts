/**
 * Persists the Account API session in the OS credential store.
 *
 * The bearer token is a long-lived account credential, so it belongs next to the
 * other secrets in keytar rather than in a JSON file. Only the minimum is
 * stored: the token, when it expires, and the account id/email for display.
 * The router token itself is written to the existing router slot by
 * `applyProvisionedRouter`, keeping one credential per purpose.
 */

import { mainLogger } from '../logger';

export interface AccountSession {
  token: string;
  /** ISO timestamp; the client treats the session as expired past this. */
  expiresAt: string;
  account: { id: string; email: string };
}

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

const ACCOUNT_SERVICE = 'com.mypilot.desktop.account';
const ACCOUNT_KEY = 'session';

function getKeytar(): KeytarLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('keytar') as KeytarLike;
  } catch {
    return null;
  }
}

let cache: AccountSession | null | undefined;

export function isSessionExpired(session: AccountSession | null, now = Date.now()): boolean {
  if (!session) return true;
  const expires = Date.parse(session.expiresAt);
  if (!Number.isFinite(expires)) return true;
  // Treat a session as expired slightly early so a request cannot start just
  // before expiry and fail mid-flight.
  return expires - 30_000 <= now;
}

export async function loadAccountSession(): Promise<AccountSession | null> {
  if (cache !== undefined) return cache;
  const keytar = getKeytar();
  if (!keytar) {
    cache = null;
    return cache;
  }
  try {
    const raw = await keytar.getPassword(ACCOUNT_SERVICE, ACCOUNT_KEY);
    if (!raw) {
      cache = null;
      return cache;
    }
    const parsed = JSON.parse(raw) as AccountSession;
    if (!parsed?.token || !parsed?.expiresAt || !parsed?.account?.id) {
      cache = null;
      return cache;
    }
    cache = parsed;
    return cache;
  } catch (err) {
    mainLogger.warn('account.session.loadFailed', { error: (err as Error).message });
    cache = null;
    return cache;
  }
}

export async function saveAccountSession(session: AccountSession): Promise<void> {
  cache = session;
  const keytar = getKeytar();
  if (!keytar) {
    mainLogger.warn('account.session.saveSkipped', { reason: 'keytar-unavailable' });
    return;
  }
  try {
    await keytar.setPassword(ACCOUNT_SERVICE, ACCOUNT_KEY, JSON.stringify(session));
    mainLogger.info('account.session.saved', { accountId: session.account.id });
  } catch (err) {
    mainLogger.error('account.session.saveFailed', { error: (err as Error).message });
  }
}

export async function clearAccountSession(): Promise<void> {
  cache = null;
  const keytar = getKeytar();
  if (!keytar) return;
  try {
    await keytar.deletePassword(ACCOUNT_SERVICE, ACCOUNT_KEY);
  } catch (err) {
    mainLogger.warn('account.session.clearFailed', { error: (err as Error).message });
  }
}

/** Test seam: drop the in-process cache. */
export function resetAccountSessionCache(): void {
  cache = undefined;
}
