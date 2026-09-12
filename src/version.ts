/**
 * Version reporting and self-update.
 *
 * The published repo carries a `version.json` written by
 * `scripts/publish-public.sh` at publish time, and the installer copies the
 * whole snapshot into `~/.arc-cli/app`, so the installed build can identify
 * itself. Running from a source checkout has no stamp — that reports as
 * `dev`, which is accurate rather than a fabricated version number.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getArcHome } from './runtime-paths.js';

export interface VersionStamp {
  version: string;
  commit: string;
  builtAt: string;
}

export const VERSION_MANIFEST_URL =
  'https://raw.githubusercontent.com/ashrithps/arc-cli/main/version.json';

export const INSTALLER_URL =
  'https://raw.githubusercontent.com/ashrithps/arc-cli/main/install.sh';

export function getAppDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getArcHome(env), 'app');
}

function readStamp(file: string): VersionStamp | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw.commit !== 'string') return null;
    return {
      version: String(raw.version ?? 'unknown'),
      commit: String(raw.commit),
      builtAt: String(raw.builtAt ?? 'unknown'),
    };
  } catch {
    return null;
  }
}

/**
 * The stamp for the build that is actually running.
 *
 * Prefers a `version.json` sitting next to the running source (a published
 * snapshot), then the installed app dir. Returns null from a dev checkout.
 */
export function getLocalVersion(env: NodeJS.ProcessEnv = process.env): VersionStamp | null {
  const here = path.resolve(new URL('..', import.meta.url).pathname, 'version.json');
  return readStamp(here) ?? readStamp(path.join(getAppDir(env), 'version.json'));
}

export function formatVersion(stamp: VersionStamp | null): string {
  if (!stamp) return 'arc dev (running from source — no published stamp)';
  return `arc ${stamp.version} (${stamp.commit.slice(0, 8)}, built ${stamp.builtAt})`;
}

/**
 * Fetch the stamp published on `main`. Returns null when unreachable.
 *
 * `accept-encoding: identity` is load-bearing, not tidiness.
 * `raw.githubusercontent.com` sits behind a CDN that varies its cache on
 * Accept-Encoding, and the two variants fall out of sync after a push: the
 * gzipped copy kept serving the previous commit for minutes while the
 * identity copy was already current. Node's fetch asks for gzip by default
 * and curl does not, which is why curl saw a new release and `arc update`
 * did not.
 *
 * Left alone, `arc update --check` reports "already up to date" in the exact
 * window after a release when it most needs to be right. Neither
 * `cache: 'no-store'` (local HTTP cache only) nor a cache-busting query
 * parameter (the CDN does not key on it) fixes that; asking for the
 * uncompressed variant does. The manifest is ~100 bytes, so there is nothing
 * to compress anyway.
 */
export async function fetchPublishedVersion(
  url: string = VERSION_MANIFEST_URL
): Promise<VersionStamp | null> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: {
        'accept-encoding': 'identity',
        'cache-control': 'no-cache',
      },
    } as RequestInit);
    if (!res.ok) return null;
    const raw: any = await res.json();
    if (!raw || typeof raw.commit !== 'string') return null;
    return {
      version: String(raw.version ?? 'unknown'),
      commit: String(raw.commit),
      builtAt: String(raw.builtAt ?? 'unknown'),
    };
  } catch {
    return null;
  }
}

export type UpdateStatus =
  | { state: 'current'; local: VersionStamp; remote: VersionStamp }
  | { state: 'behind'; local: VersionStamp | null; remote: VersionStamp }
  | { state: 'ahead'; local: VersionStamp; remote: VersionStamp }
  | { state: 'unknown-local'; local: null; remote: VersionStamp }
  | { state: 'unreachable'; local: VersionStamp | null; remote: null };

function builtAtMs(stamp: VersionStamp): number {
  const t = Date.parse(stamp.builtAt);
  return Number.isFinite(t) ? t : 0;
}

export function compareVersions(
  local: VersionStamp | null,
  remote: VersionStamp | null
): UpdateStatus {
  if (!remote) return { state: 'unreachable', local, remote: null };
  if (!local) return { state: 'unknown-local', local: null, remote };
  if (local.commit === remote.commit) return { state: 'current', local, remote };

  // Commit hashes carry no ordering, so a mismatch alone cannot tell "behind"
  // from "ahead". Build timestamps can. Installing from a local checkout (which
  // install.sh supports) legitimately puts you ahead of what is published, and
  // nagging that person to "update" to an older build is worse than useless.
  // Unparseable timestamps sort to 0, which lands on `behind` — the safe
  // default, since it only ever suggests re-running the installer.
  if (builtAtMs(local) > builtAtMs(remote)) return { state: 'ahead', local, remote };
  return { state: 'behind', local, remote };
}
