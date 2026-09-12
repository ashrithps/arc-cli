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

/** Fetch the stamp published on `main`. Returns null when unreachable. */
export async function fetchPublishedVersion(
  url: string = VERSION_MANIFEST_URL
): Promise<VersionStamp | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' } as RequestInit);
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
  | { state: 'unknown-local'; local: null; remote: VersionStamp }
  | { state: 'unreachable'; local: VersionStamp | null; remote: null };

export function compareVersions(
  local: VersionStamp | null,
  remote: VersionStamp | null
): UpdateStatus {
  if (!remote) return { state: 'unreachable', local, remote: null };
  if (!local) return { state: 'unknown-local', local: null, remote };
  if (local.commit === remote.commit) return { state: 'current', local, remote };
  return { state: 'behind', local, remote };
}
