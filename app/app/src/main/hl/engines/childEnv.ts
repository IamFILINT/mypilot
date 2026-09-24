/**
 * Environment allowlist for spawned engines.
 *
 * Engines used to inherit the full `process.env`, so every sidecar and CLI
 * received whatever credentials happened to be in the desktop process's
 * environment — cloud keys, CI tokens, other providers' API keys. The MyPilot
 * Agent sidecar in particular runs third-party Python code, so handing it the
 * whole environment is an unnecessary credential-exposure risk.
 *
 * Child processes now start from this explicit allowlist instead. Anything not
 * listed here is dropped, and adapters add only what their engine needs.
 */

/** Variables every child process needs to find its interpreter and libraries. */
const SYSTEM_ALLOWLIST = [
  // Executable resolution
  'PATH',
  'PATHEXT',
  // User/session identity and home
  'HOME',
  'USER',
  'LOGNAME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  // Windows process essentials (spawning cmd.exe and friends needs these)
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  // Temp dirs
  'TMP',
  'TEMP',
  'TMPDIR',
  // Locale/timezone
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TZ',
  // Shell/terminal
  'TERM',
  'SHELL',
  'COLORTERM',
  // X11 / Wayland — the sidecar drives a real browser window
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  // TLS trust — many users sit behind a corporate or local CA
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  // Proxies — routinely required to reach model providers
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // Browser/Playwright cache locations
  'PLAYWRIGHT_BROWSERS_PATH',
  'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
  // Internal dev/build overrides
  'BU_TARGET_ID',
  'BU_CDP_PORT',
  'AGB_USER_DATA_DIR',
  'MYPILOT_PYTHON_RUNTIME_DIR',
];

/**
 * Credential-shaped variables that must never be forwarded even if a future
 * edit adds them to the allowlist above.
 */
const ALWAYS_DENIED = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_API_BASE',
  'OPENAI_BASE_URL',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'DOCKER_PASSWORD',
  'VAULT_TOKEN',
  'BU_ROUTER_TOKEN',
];

const ALLOW = new Set(SYSTEM_ALLOWLIST);
const DENY = new Set(ALWAYS_DENIED);

/**
 * Build the base environment for a spawned engine.
 *
 * @param source environment to filter; defaults to the main process env
 */
export function sanitizedChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (DENY.has(upper)) continue;
    // Match case-insensitively for POSIX allowlist entries while preserving the
    // original spelling Windows expects.
    const allowed = [...ALLOW].some((candidate) => candidate.toUpperCase() === upper);
    if (!allowed) continue;
    out[key] = value;
  }
  return out;
}

/** True when a variable is blocked from child processes. */
export function isDeniedChildEnvVar(name: string): boolean {
  return DENY.has(name.toUpperCase());
}
