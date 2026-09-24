/**
 * Favicons are fetched directly from each site's own origin.
 *
 * This previously used Google's favicon service, which sent every visited
 * hostname to a third party — independently of the telemetry consent toggle,
 * and unusable on networks where Google is unreachable. Fetching from the site
 * discloses nothing to anyone else and works wherever the site itself does.
 */
const FAVICON_SIZE = 64;
export const DOMAIN_FAVICON_DISPLAY_SIZE = 16;

/** Local placeholder: a neutral globe, rendered without any network request. */
const DEFAULT_FAVICON_URL =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
      '<rect width="16" height="16" rx="3" fill="#2f3336"/>' +
      '<circle cx="8" cy="8" r="4.5" fill="none" stroke="#8b949e" stroke-width="1"/>' +
      '<path d="M3.5 8h9M8 3.5c1.4 1.3 1.4 7.7 0 9M8 3.5c-1.4 1.3-1.4 7.7 0 9" ' +
      'fill="none" stroke="#8b949e" stroke-width=".8"/></svg>',
  );

export function getFaviconUrl(domain: string): string {
  const host = extractHostname(domain);
  // Only ever hit https for the icon; http sites get the same attempt and fall
  // back to the local placeholder on error.
  return `https://${host}/favicon.ico?v=${FAVICON_SIZE}`;
}

export function extractHostname(domain: string): string {
  try {
    const domainWithProtocol = domain.startsWith('http') ? domain : `https://${domain}`;
    const url = new URL(domainWithProtocol);
    return url.hostname;
  } catch {
    return domain;
  }
}

export function sortDomains(domains: string[], domainsWithDefaultFavicons?: Set<string>): string[] {
  return [...domains].sort((a, b) => {
    if (domainsWithDefaultFavicons) {
      const aHasDefault = domainsWithDefaultFavicons.has(a);
      const bHasDefault = domainsWithDefaultFavicons.has(b);
      if (aHasDefault !== bHasDefault) {
        return aHasDefault ? 1 : -1;
      }
    }
    const hostnameA = extractHostname(a).toLowerCase();
    const hostnameB = extractHostname(b).toLowerCase();
    return hostnameA.localeCompare(hostnameB);
  });
}

let defaultFaviconDataUrlCache: string | null = null;

async function loadDefaultFaviconDataUrl(): Promise<string> {
  // The placeholder is an inline SVG, so no network request and no canvas
  // read-back (which used to fail for cross-origin images anyway).
  defaultFaviconDataUrlCache ??= DEFAULT_FAVICON_URL;
  return defaultFaviconDataUrlCache;
}

export async function isDefaultFavicon(img: HTMLImageElement): Promise<boolean> {
  const defaultUrl = await loadDefaultFaviconDataUrl();
  const current = img.getAttribute('src') ?? img.src;
  return current === defaultUrl || current.startsWith(defaultUrl);
}
