/**
 * Single source of truth for where MyPilot releases are published.
 *
 * Why this exists: the auto-updater originally pointed at
 * `github.com/browser-use/desktop/releases` — the upstream Browser Use fork.
 * Anything published there would have been offered as an update to every
 * MyPilot install, so whoever controls that repo controls our shipped code.
 * All release URLs now derive from this one place, and
 * tests/unit/releaseChannel.test.ts fails if an upstream reference reappears or
 * the owner is left unset.
 *
 * SET THIS to your GitHub username/org before the first public release. Until
 * then the packaging preflight refuses to build a shippable artifact.
 */

/** GitHub owner (user or org) that publishes MyPilot releases. */
export const RELEASE_OWNER: string = 'IamFILINT';

/** Release repository name. */
export const RELEASE_REPO: string = 'mypilot';

/** electron-updater cache subdirectory; keeps MyPilot state separate. */
export const RELEASE_CACHE_DIR: string = 'mypilot-updater';

/** Placeholder owner — any build with this value must not ship. */
export const UNSET_OWNER: string = 'REPLACE_WITH_GITHUB_USERNAME';

export function releaseRepoSlug(): string {
  return `${RELEASE_OWNER}/${RELEASE_REPO}`;
}

/**
 * Generic release-asset feed. electron-updater fetches `latest-mac.yml`,
 * `latest-linux.yml`, and friends straight from the published release assets.
 */
export function releaseFeedUrl(): string {
  return `https://github.com/${releaseRepoSlug()}/releases/latest/download`;
}

/** GitHub API endpoint used to read the latest release's notes. */
export function latestReleaseApiUrl(): string {
  return `https://api.github.com/repos/${releaseRepoSlug()}/releases/latest`;
}

export function isReleaseOwnerConfigured(): boolean {
  return RELEASE_OWNER !== UNSET_OWNER && !RELEASE_OWNER.startsWith('REPLACE_WITH');
}
