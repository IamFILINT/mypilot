/**
 * Generates app-update.yml for the packaged app and verifies the release
 * channel is safe to ship.
 *
 * app-update.yml is an extraResource, but electron-updater reads it during the
 * download/install phase. Keeping it hand-maintained let it drift onto the
 * upstream Browser Use fork's release channel, so it is generated from
 * src/shared/releaseChannel.ts at package time instead.
 *
 * Fails the build when the release owner is still the placeholder: shipping
 * that would either break updates or point them at a repo we do not control.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const channelSource = path.join(appDir, 'src/shared/releaseChannel.ts');
const target = path.join(appDir, 'app-update.yml');

/** Reads the exported string constants without importing TS at build time. */
function readChannelConstants() {
  const source = fs.readFileSync(channelSource, 'utf8');
  // Tolerate an explicit `: string` annotation, which keeps TypeScript from
  // narrowing these to literal types (and so comparing against the placeholder
  // in isReleaseOwnerConfigured stays meaningful).
  const read = (name) =>
    new RegExp(`export const ${name}\\s*(?::\\s*string)?\\s*=\\s*'([^']*)'`).exec(source)?.[1];
  const owner = read('RELEASE_OWNER');
  const repo = read('RELEASE_REPO');
  const cache = read('RELEASE_CACHE_DIR');
  if (!owner || !repo) {
    throw new Error(`write-app-update: could not read release channel from ${channelSource}`);
  }
  return { owner, repo, cache: cache ?? 'mypilot-updater' };
}

export function writeAppUpdate({ allowUnsetOwner = false } = {}) {
  const { owner, repo, cache } = readChannelConstants();

  if (!owner || owner.startsWith('REPLACE_WITH')) {
    const message =
      'Release owner is not configured. Set RELEASE_OWNER in src/shared/releaseChannel.ts to the ' +
      'GitHub user/org that publishes MyPilot releases before building a shippable artifact.';
    if (!allowUnsetOwner) throw new Error(`write-app-update: ${message}`);
    process.stdout.write(`  warn  ${message}\n`);
  }

  // Upstream must never appear: a build pointing there would offer upstream
  // releases as MyPilot updates.
  if (owner === 'browser-use' || repo === 'desktop') {
    throw new Error(
      'write-app-update: refusing to point the update feed at browser-use/desktop. ' +
        'Set RELEASE_OWNER/RELEASE_REPO to your own repository.',
    );
  }

  const contents = [
    'provider: generic',
    `url: https://github.com/${owner}/${repo}/releases/latest/download`,
    `updaterCacheDirName: ${cache}`,
    '',
  ].join('\n');

  fs.writeFileSync(target, contents);
  process.stdout.write(`  write app-update.yml -> github.com/${owner}/${repo}\n`);
  return target;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    writeAppUpdate({ allowUnsetOwner: process.env.MYPILOT_ALLOW_UNSET_RELEASE_OWNER === '1' });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
