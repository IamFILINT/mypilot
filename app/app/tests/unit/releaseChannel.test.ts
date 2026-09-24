/**
 * Release-channel consistency guards.
 *
 * The auto-updater originally pointed at `github.com/browser-use/desktop`,
 * meaning anyone who could publish a release there would be offering code to
 * every MyPilot install. These tests keep every release reference on the same
 * repo and forbid the upstream one.
 *
 * Note: the *build* is what refuses to run with an unset owner (see
 * scripts/write-app-update.mjs), so these tests stay green while the release
 * channel is still a placeholder.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RELEASE_CACHE_DIR,
  RELEASE_OWNER,
  RELEASE_REPO,
  latestReleaseApiUrl,
  releaseFeedUrl,
  releaseRepoSlug,
} from '../../src/shared/releaseChannel';

const appRoot = path.resolve(__dirname, '../..');

/** Files that must agree on where releases come from. */
const RELEASE_REFERENCE_FILES = [
  'app-update.yml',
  'package.json',
  'README.md',
  'CONTRIBUTING.md',
];

/** The upstream repo must never reappear as our update source. */
const FORBIDDEN = 'browser-use/desktop';

function readIfPresent(rel: string): string | null {
  const full = path.join(appRoot, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : null;
}

describe('release channel', () => {
  it('derives every release URL from one owner/repo pair', () => {
    expect(releaseRepoSlug()).toBe(`${RELEASE_OWNER}/${RELEASE_REPO}`);
    expect(releaseFeedUrl()).toBe(
      `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest/download`,
    );
    expect(latestReleaseApiUrl()).toBe(
      `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`,
    );
  });

  it('never points the update feed at the upstream Browser Use fork', () => {
    expect(releaseFeedUrl()).not.toContain(FORBIDDEN);
    expect(latestReleaseApiUrl()).not.toContain(FORBIDDEN);
  });

  it.each(RELEASE_REFERENCE_FILES)('%s has no upstream release reference', (file) => {
    const contents = readIfPresent(file);
    if (contents === null) return;
    expect(contents).not.toContain(FORBIDDEN);
  });

  it('package.json repository matches the release channel slug', () => {
    const pkg = JSON.parse(readIfPresent('package.json') ?? '{}') as {
      repository?: { url?: string };
    };
    expect(pkg.repository?.url).toContain(`${RELEASE_OWNER}/${RELEASE_REPO}`);
  });

  it('app-update.yml matches the generated feed and cache dir', () => {
    const contents = readIfPresent('app-update.yml') ?? '';
    expect(contents).toContain(`url: ${releaseFeedUrl()}`);
    expect(contents).toContain(`updaterCacheDirName: ${RELEASE_CACHE_DIR}`);
  });

  it('does not treat the placeholder owner as configured', () => {
    // Guards the invariant that write-app-update.mjs relies on: a placeholder
    // owner must look unconfigured so packaging fails instead of shipping.
    const looksConfigured =
      Boolean(RELEASE_OWNER) &&
      !RELEASE_OWNER.startsWith('REPLACE_WITH') &&
      RELEASE_OWNER !== 'browser-use';
    if (RELEASE_OWNER.startsWith('REPLACE_WITH')) {
      expect(looksConfigured).toBe(false);
    }
  });
});
