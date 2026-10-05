/**
 * Where this machine keeps arc's secrets.
 *
 * Ported from vault-cli `src/core/keychain.ts`, made synchronous because the
 * Actual config loader (`loadRuntimeConfig`) is synchronous and every command
 * goes through it.
 *
 * - macOS: the login Keychain, through `/usr/bin/security`.
 * - Linux: the Secret Service, through `secret-tool`, when it is installed.
 * - `ARC_KEYCHAIN=file` (tests, or a deliberate choice): `secrets.json` in the
 *   arc home, mode 0600.
 *
 * A secret never appears in a process's argv, where any local user can read
 * it with `ps`: `security` gets its command line on stdin through
 * `security -i`, and `secret-tool store` reads the secret from stdin. Values
 * are base64-encoded before they reach `security`, so the quoted command line
 * has nothing in it that needs escaping.
 *
 * The service is `arc-cli`. A non-default arc home (`ARC_CONFIG_DIR`, or a
 * HOME other than the real one) namespaces it, so a second install — or a
 * test run — never reads or overwrites the main install's entries.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from 'node:child_process';
import { getArcHome } from '../runtime-paths.js';

export interface Keychain {
  readonly name: 'macos-keychain' | 'secret-service' | 'file';
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

type SpawnSync = (cmd: string, args: string[], opts: { input?: string; encoding: 'utf-8'; timeout: number }) =>
  Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;

let spawnImpl: SpawnSync = nodeSpawnSync as unknown as SpawnSync;

/** Tests only: observe or fake the subprocess calls. */
export function setKeychainSpawn(fn: SpawnSync | null): void {
  spawnImpl = fn ?? (nodeSpawnSync as unknown as SpawnSync);
  cache.clear();
}

const SECURITY = '/usr/bin/security';
const SERVICE = 'arc-cli';

export function keychainService(env: NodeJS.ProcessEnv = process.env): string {
  const home = path.resolve(getArcHome(env));
  const defaultHome = path.resolve(path.join(os.homedir(), '.arc-cli'));
  if (!env.ARC_CONFIG_DIR && home === defaultHome) return SERVICE;
  const tag = crypto.createHash('sha256').update(home).digest('hex').slice(0, 8);
  return `${SERVICE}-${tag}`;
}

/** Keys are our own identifiers (budget sync ids included); anything else is a bug. */
export function assertKeyName(key: string): void {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw new Error(`Invalid keychain key: ${key}`);
}

// ── macOS ───────────────────────────────────────────────────────────────────

function createMacKeychain(service: string): Keychain {
  const run = (args: string[], input?: string) =>
    spawnImpl(SECURITY, args, { input, encoding: 'utf-8', timeout: 10_000 });

  const read = (key: string): string | null => {
    const r = run(['find-generic-password', '-s', service, '-a', key, '-w']);
    // 44 is errSecItemNotFound; anything else non-zero is a real failure.
    if (r.status === 44) return null;
    if (r.status !== 0) throw new Error(`security find-generic-password failed (${r.status})`);
    return Buffer.from(r.stdout.replace(/\n$/, ''), 'base64').toString('utf-8');
  };

  return {
    name: 'macos-keychain',
    get(key) {
      assertKeyName(key);
      return read(key);
    },
    set(key, value) {
      assertKeyName(key);
      const encoded = Buffer.from(value, 'utf-8').toString('base64');
      const command = `add-generic-password -U -s "${service}" -a "${key}" -l "arc ${key}" -w "${encoded}"\n`;
      const r = run(['-i'], command);
      if (r.status !== 0) throw new Error(`security add-generic-password failed (${r.status})`);
      // `security -i` does not always carry a failed command into its exit
      // status, so the write is confirmed by reading it back.
      if (read(key) !== value) throw new Error('Keychain write did not read back');
    },
    delete(key) {
      assertKeyName(key);
      const r = run(['delete-generic-password', '-s', service, '-a', key]);
      if (r.status !== 0 && r.status !== 44) throw new Error(`security delete-generic-password failed (${r.status})`);
    },
  };
}

// ── Linux ───────────────────────────────────────────────────────────────────

function hasSecretTool(): boolean {
  const r = spawnImpl('sh', ['-c', 'command -v secret-tool'], { encoding: 'utf-8', timeout: 5_000 });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function createSecretToolKeychain(service: string): Keychain {
  const attrs = (key: string) => ['service', service, 'account', key];
  return {
    name: 'secret-service',
    get(key) {
      assertKeyName(key);
      const r = spawnImpl('secret-tool', ['lookup', ...attrs(key)], { encoding: 'utf-8', timeout: 10_000 });
      // lookup exits 1 both for "no such item" and for a missing bus; stderr tells them apart.
      if (r.status !== 0) {
        if (r.error || (r.stderr && r.stderr.trim())) throw new Error('secret-tool lookup failed');
        return null;
      }
      return r.stdout.length > 0 ? r.stdout : null;
    },
    set(key, value) {
      assertKeyName(key);
      const r = spawnImpl('secret-tool', ['store', `--label=arc ${key}`, ...attrs(key)], {
        input: value, encoding: 'utf-8', timeout: 10_000,
      });
      if (r.status !== 0) throw new Error('secret-tool store failed');
      if (this.get(key) !== value) throw new Error('Secret Service write did not read back');
    },
    delete(key) {
      assertKeyName(key);
      spawnImpl('secret-tool', ['clear', ...attrs(key)], { encoding: 'utf-8', timeout: 10_000 });
    },
  };
}

// ── File ────────────────────────────────────────────────────────────────────

export function secretsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getArcHome(env), 'secrets.json');
}

/** The 0600 file store, for callers that must persist even with no OS keychain. */
export function getFileKeychain(env: NodeJS.ProcessEnv = process.env): Keychain {
  return createFileKeychain(env);
}

function createFileKeychain(env: NodeJS.ProcessEnv): Keychain {
  const file = secretsFilePath(env);
  const readAll = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return {};
    }
  };
  const writeAll = (secrets: Record<string, string>) => {
    if (Object.keys(secrets).length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };
  return {
    name: 'file',
    get(key) {
      assertKeyName(key);
      return readAll()[key] ?? null;
    },
    set(key, value) {
      assertKeyName(key);
      const secrets = readAll();
      secrets[key] = value;
      writeAll(secrets);
    },
    delete(key) {
      const secrets = readAll();
      if (!(key in secrets)) return;
      delete secrets[key];
      writeAll(secrets);
    },
  };
}

// ── Selection ───────────────────────────────────────────────────────────────

const cache = new Map<string, Keychain | null>();

/**
 * The secret store for this arc home, or null when the machine has none.
 *
 * Null is a real answer: the caller leaves secrets where they are rather
 * than inventing a weaker home for them.
 */
export function getKeychain(env: NodeJS.ProcessEnv = process.env): Keychain | null {
  const forced = env.ARC_KEYCHAIN ?? process.env.ARC_KEYCHAIN;
  const home = path.resolve(getArcHome(env));
  const cacheKey = `${forced ?? 'auto'}|${home}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  let kc: Keychain | null;
  if (forced === 'file') kc = createFileKeychain(env);
  else if (forced === 'none') kc = null;
  else if (process.platform === 'darwin' && fs.existsSync(SECURITY)) kc = createMacKeychain(keychainService(env));
  else if (process.platform === 'linux' && hasSecretTool()) kc = createSecretToolKeychain(keychainService(env));
  else kc = null;

  cache.set(cacheKey, kc);
  return kc;
}

/** Read a secret, treating an unreachable store (locked over SSH, no bus) as absent. */
export function readSecret(key: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return getKeychain(env)?.get(key) ?? null;
  } catch {
    return null;
  }
}
