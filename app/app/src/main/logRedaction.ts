/**
 * Redaction for log payloads.
 *
 * Logs are written to disk in plain JSON and can be exported from Settings, so
 * they must never carry credentials, one-time codes, or the query strings that
 * URLs use to carry them. This module is applied centrally in
 * `sanitizeLogExtra`, so every logger call site is covered without each one
 * having to remember.
 *
 * Deliberately conservative: only values that look like credentials or URLs
 * with query strings are touched, so ordinary diagnostic fields stay readable.
 */

const REDACTED = '[redacted]';

/** Field names whose values are always secret. */
const SECRET_KEY_PATTERN =
  /(?:^|_)(token|secret|password|passwd|api_?key|apikey|authorization|auth|cookie|credential|private_?key|session_?id|otp|code)(?:$|_)/;

/** Field names that hold free-form user content rather than diagnostics. */
const CONTENT_KEY_PATTERN =
  /(?:^|_)(prompt|wrapped_?prompt|message|content|body|response|summary|thought|next_?goal|evaluation|args)(?:$|_)/;

/**
 * Normalize a field name for matching: split camelCase into words, lowercase,
 * and treat any non-alphanumeric run as a separator. Without this, `routerToken`
 * and `ANTHROPIC_API_KEY` would need two separate patterns.
 */
function normalizeFieldName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** Credential shapes that must never reach disk. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g, // OpenAI / Anthropic style
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API key
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex (tokens, signatures)
];

/** Query parameters that carry credentials or one-time codes. */
const SENSITIVE_QUERY_KEYS =
  /^(code|access_token|refresh_token|id_token|token|api[-_]?key|key|secret|password|auth|authorization|session|ticket|state|otp)$/i;

/** True when a field name indicates its value must be dropped entirely. */
export function isSecretFieldName(name: string): boolean {
  return SECRET_KEY_PATTERN.test(normalizeFieldName(name));
}

/** True when a field name holds user content that should be summarized. */
export function isContentFieldName(name: string): boolean {
  return CONTENT_KEY_PATTERN.test(normalizeFieldName(name));
}

/**
 * Strip credentials from a URL, keeping origin and path so logs stay useful.
 * Returns null when the input is not an http(s) URL.
 */
export function sanitizeUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
  }
  // Query strings hold one-time codes and signed links; keep only the keys so
  // it is still obvious which flow ran.
  const keys = [...url.searchParams.keys()];
  url.search = '';
  if (keys.length > 0) {
    url.search = `?${[...new Set(keys)].map((k) => (SENSITIVE_QUERY_KEYS.test(k) ? `${k}=${REDACTED}` : k)).join('&')}`;
  }
  url.hash = '';
  return url.toString();
}

/** Replace credential-shaped substrings inside free text. */
export function redactSecretsInText(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Stable, non-reversible stand-in used when a value must be correlatable. */
export function fingerprint(value: string): string {
  // FNV-1a: short, dependency-free, and only ever used to tell two values
  // apart in logs — never to protect anything.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `len${value.length}:${hash.toString(16).padStart(8, '0')}`;
}

const MAX_STRING = 300;

/** Redact one string value, sanitizing URLs and truncating long text. */
export function redactString(value: string): string {
  const asUrl = sanitizeUrl(value);
  const base = asUrl ?? value;
  const redacted = redactSecretsInText(base);
  return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…` : redacted;
}

/**
 * Redact an arbitrary log value.
 *
 * - secret-named fields → replaced entirely
 * - content-named fields → replaced with a fingerprint (length + hash) so
 *   incidents remain diagnosable without the text landing on disk
 * - strings → credential patterns stripped, URLs sanitized, long text truncated
 */
export function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (isSecretFieldName(key)) return REDACTED;
  if (isContentFieldName(key) && typeof value === 'string') return fingerprint(value);

  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth > 3) return '[array]';
    return value.slice(0, 20).map((item) =>
      typeof item === 'string'
        ? redactString(item)
        : redactValue(key, item, depth + 1),
    );
  }
  if (typeof value === 'object') {
    if (depth > 3) return '[object]';
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactValue(childKey, childValue, depth + 1);
    }
    return out;
  }
  // Functions/symbols/bigints carry no diagnostic value in a log line.
  return `[${typeof value}]`;
}
