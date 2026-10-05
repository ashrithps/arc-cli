/**
 * Renewing the arc Premium licence that lets this CLI reach a self-hosted
 * Actual server (see utils/arc-host.ts). Only a paired machine can renew: the
 * agent connection is the only identity the CLI has. An unpaired install
 * renews by copying a fresh install command from the app.
 *
 * Best effort throughout. A failed renewal keeps the old licence, and the
 * host check reports an expiry with instructions when it finally matters.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getArcHome } from '../runtime-paths.js';
import { getInstalledConfig, saveCliLicense } from '../credential-store.js';
import {
  assertAllowedHost,
  isArcManagedUrl,
  licenseHostFor,
  verifyCliLicenseSignature,
} from '../utils/arc-host.js';
import type { AgentApi } from './api.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const LICENSE_RENEW_WINDOW_MS = 7 * DAY_MS;
/** A licence that is still valid is not worth more than one attempt an hour. */
const RETRY_AFTER_MS = 60 * 60 * 1000;

export type LicenseState = 'not-needed' | 'ok' | 'expiring' | 'invalid';

export function cliLicenseState(apiUrl: string, license: string | undefined, now: number = Date.now()): LicenseState {
  if (isArcManagedUrl(apiUrl)) return 'not-needed';
  if (!license) return 'invalid';
  try {
    const payload = verifyCliLicenseSignature(license);
    if (payload.host !== licenseHostFor(apiUrl) || !(payload.exp > now)) return 'invalid';
    return payload.exp - now < LICENSE_RENEW_WINDOW_MS ? 'expiring' : 'ok';
  } catch {
    return 'invalid';
  }
}

function attemptMarker(env: NodeJS.ProcessEnv): string {
  return path.join(getArcHome(env), '.license-renew-attempt');
}

/**
 * Fetch and store a new licence when the saved one is missing, invalid, or
 * (unless `onlyIfInvalid`) inside its last week. Returns true when it stored
 * one. `api` is a factory so a machine that needs nothing pays nothing.
 *
 * Environment overrides are left alone: a licence saved for the host in
 * ACTUAL_SERVER_URL would follow the config file to a different server, and
 * ARC_CLI_LICENSE means the user is supplying their own.
 */
export async function renewCliLicenseIfNeeded(
  api: AgentApi | null | (() => AgentApi | null),
  options: { env?: NodeJS.ProcessEnv; now?: number; onlyIfInvalid?: boolean } = {}
): Promise<boolean> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  if (env.ARC_CLI_LICENSE || env.ACTUAL_SERVER_URL) return false;
  try {
    const config = getInstalledConfig(env);
    if (!config.apiUrl) return false;
    const state = cliLicenseState(config.apiUrl, config.cliLicense, now);
    if (state === 'not-needed' || state === 'ok') return false;
    if (state === 'expiring' && (options.onlyIfInvalid || recentlyAttempted(env, now))) return false;

    const client = typeof api === 'function' ? api() : api;
    if (!client) return false;
    recordAttempt(env, now);
    const res = await client.cliLicense(config.apiUrl);
    // Never store something the host check would refuse.
    assertAllowedHost(config.apiUrl, 'renewed licence', res.license, now);
    saveCliLicense(res.license, env);
    return true;
  } catch {
    return false;
  }
}

function recentlyAttempted(env: NodeJS.ProcessEnv, now: number): boolean {
  try {
    const at = Number(fs.readFileSync(attemptMarker(env), 'utf8'));
    return Number.isFinite(at) && now - at < RETRY_AFTER_MS;
  } catch {
    return false;
  }
}

function recordAttempt(env: NodeJS.ProcessEnv, now: number): void {
  try {
    fs.mkdirSync(path.dirname(attemptMarker(env)), { recursive: true });
    fs.writeFileSync(attemptMarker(env), String(now));
  } catch { /* best effort */ }
}
