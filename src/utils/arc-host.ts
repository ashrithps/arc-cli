import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

const REACTOR_SUFFIX = '.reactor.arc.moi';
// ArcReactor creates managed Actual services with the `ab-` service prefix in
// its controlled Cloud Run project. This is intentionally not a general
// `*.run.app` allowance: the `ab-` prefix and the project hash are the trust
// anchor, and both stay mandatory.
//
// The region code is the last two letters (`ew` europe-west, `uw` us-west,
// `uc` us-central, …). It must NOT be pinned — arcreactor provisions instances
// in whichever region the user is closest to, and hardcoding one locks every
// other region out of their own server.
const MANAGED_CLOUD_RUN_HOST =
  /^ab-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-z6lmrduzva-[a-z]{2}\.a\.run\.app$/;

function isArcManagedHost(hostname: string): boolean {
  return hostname.endsWith(REACTOR_SUFFIX) || MANAGED_CLOUD_RUN_HOST.test(hostname);
}

/** True for a URL on an arc-managed server, which needs no licence. Never throws. */
export function isArcManagedUrl(apiUrl: string): boolean {
  try {
    const parsed = new URL(apiUrl);
    return parsed.protocol === 'https:' && isArcManagedHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function assertArcHost(apiUrl: string, source: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(
      `Invalid ${source}: "${apiUrl}" is not a valid URL. ` +
      'Arc only connects to verified arc-managed servers.'
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid ${source}: "${apiUrl}" must use https. ` +
      'Arc only connects to verified arc-managed servers.'
    );
  }

  if (!isArcManagedHost(parsed.hostname)) {
    throw new Error(
      `Invalid ${source}: "${parsed.hostname}" is not an arc-managed host. ` +
      'Arc only connects to verified arc-managed servers. ' +
      'Self-hosted Actual servers are not supported by this build.'
    );
  }
}

// ── Self-hosted servers: the arc Premium licence ────────────────────────────
//
// A self-hosted (BYOB) Actual server is allowed only with a licence arcreactor
// signed for that exact host. Token: `<payloadB64>.<sigB64>`, base64url without
// padding, ECDSA P-256 / SHA-256 over the ASCII of `payloadB64`, signature raw
// r||s (64 bytes). The format is shared byte for byte with arcreactor and the
// app; do not change it here alone.
//
// Verification is synchronous on purpose: config-store and payload check the
// host on every load, and WebCrypto would make both async.

/** arcreactor's licence signing key, raw uncompressed P-256, base64url. */
export const CLI_LICENSE_PUBLIC_KEY =
  'BPRvB6p_GDFmLRQR1pzGekyBz5v8ECbrZyzVjoiKY9HBqkVIUYYV1w5_-bDpbz3fNoaTbt9tV7wY0gHcFkcNhbY';

export const CLI_LICENSE_KIND = 'arc-cli-byob';

export interface CliLicensePayload {
  v: 1;
  kind: typeof CLI_LICENSE_KIND;
  host: string;
  sub: string;
  iat: number;
  exp: number;
}

export function publicKeyFromRaw(rawB64Url: string): KeyObject {
  const raw = Buffer.from(rawB64Url, 'base64url');
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error('Licence public key must be a raw uncompressed P-256 point.');
  }
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
}

let pinnedKey: KeyObject | null = null;
let keyOverride: KeyObject | null = null;

/**
 * Tests sign their own licences. Not reachable from the environment: an env
 * override would be a way to mint Premium from a shell.
 */
export function setCliLicensePublicKeyForTests(key: KeyObject | string | null): void {
  keyOverride = key == null ? null : typeof key === 'string' ? publicKeyFromRaw(key) : key;
}

function licenseKey(): KeyObject {
  if (keyOverride) return keyOverride;
  pinnedKey ??= publicKeyFromRaw(CLI_LICENSE_PUBLIC_KEY);
  return pinnedKey;
}

/** Decode a licence's payload WITHOUT checking its signature (for display only). */
export function readCliLicense(token: string | undefined): CliLicensePayload | null {
  if (!token) return null;
  const [payloadB64] = token.split('.');
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** Throws when the token is malformed or not signed by arcreactor; returns its payload otherwise. */
export function verifyCliLicenseSignature(token: string): CliLicensePayload {
  const parts = token.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('The arc Premium licence is malformed.');
  }
  const [payloadB64, sigB64] = parts;
  const signature = Buffer.from(sigB64, 'base64url');
  const ok = signature.length === 64 && verifySignature(
    'sha256',
    Buffer.from(payloadB64, 'ascii'),
    { key: licenseKey(), dsaEncoding: 'ieee-p1363' },
    signature
  );
  if (!ok) {
    throw new Error('The arc Premium licence was not signed by arc. Copy a fresh install command from the arc app (Settings → AI agents).');
  }
  const payload = readCliLicense(payloadB64);
  if (!payload || payload.v !== 1 || payload.kind !== CLI_LICENSE_KIND ||
      typeof payload.host !== 'string' || typeof payload.exp !== 'number') {
    throw new Error('The arc Premium licence is not a CLI licence this build understands.');
  }
  return payload;
}

/** The licence's `host` for a server URL: hostname plus a non-default port, lowercase. */
export function licenseHostFor(apiUrl: string): string {
  return new URL(apiUrl).host.toLowerCase();
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Loopback, RFC1918 or `*.local`: the only places a self-hosted server may use plain http. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1') return true;
  const m = IPV4.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The single host rule. Arc-managed servers pass as before (https only, no
 * licence). Anything else is a self-hosted server and needs a licence signed
 * for exactly its host that has not expired; it may use http only on a
 * private network.
 */
export function assertAllowedHost(apiUrl: string, source: string, license?: string, now: number = Date.now()): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(`Invalid ${source}: "${apiUrl}" is not a valid URL.`);
  }

  if (isArcManagedHost(parsed.hostname)) {
    assertArcHost(apiUrl, source);
    return;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Invalid ${source}: "${apiUrl}" must use https.`);
  }
  if (parsed.protocol === 'http:' && !isPrivateHost(parsed.hostname)) {
    throw new Error(
      `Invalid ${source}: "${apiUrl}" must use https. ` +
      'Plain http is only allowed for a server on this machine or your private network.'
    );
  }

  if (!license) {
    throw new Error(
      `Invalid ${source}: "${parsed.hostname}" is not an arc-managed host. ` +
      'Self-hosted Actual servers need arc Premium. ' +
      'In the arc app open Settings → AI agents and copy a fresh install command.'
    );
  }
  const payload = verifyCliLicenseSignature(license);
  const host = parsed.host.toLowerCase();
  if (payload.host !== host) {
    throw new Error(
      `Your arc Premium licence is for ${payload.host}, not ${host}. ` +
      'Copy a fresh install command from the arc app (Settings → AI agents).'
    );
  }
  if (!(payload.exp > now)) {
    throw new Error(
      `Your arc Premium licence for ${host} expired on ${formatDate(payload.exp)}. ` +
      'Copy a fresh install command from the arc app (Settings → AI agents), ' +
      'or run any command on a paired machine to renew it.'
    );
  }
}
