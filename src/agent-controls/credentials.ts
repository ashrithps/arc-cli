/**
 * Actual's secrets out of `~/.arc-cli/config.json`.
 *
 * Before Agent Controls the server password and every budget's encryption
 * password sat in plaintext in config.json, and so in every backup and
 * dotfile sync of it. This module moves them into the OS keychain once, and
 * from then on the config carries `secretsIn: "keychain"` and no secrets.
 *
 * - The migration verifies every value reads back before it strips anything,
 *   so a keychain that refuses mid-way loses nothing.
 * - With no OS keychain (headless Linux without `secret-tool`) the config is
 *   left alone and a single warning says so; a weaker invented home would
 *   only add a second place to leak from.
 * - Environment overrides (`ACTUAL_PASSWORD`, `ACTUAL_ENCRYPTION_PASSWORD`,
 *   `ACTUAL_CUSTOM_HEADERS`)
 *   still win over both stores; config-store applies them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getArcConfigPath, getArcHome } from '../runtime-paths.js';
import { getKeychain, readSecret } from './keychain.js';

export const SECRET_KEYS = {
  apiKey: 'api_key',
  encryptionPassword: 'encryption_password',
  budgetPassword: (syncId: string) => `budget_password.${syncId}`,
  // Reverse-proxy headers for a self-hosted server, as JSON [{name, value}].
  customHeaders: 'custom_headers',
  // Agent connection (written by `arc auth pair`)
  agentCredential: 'agent_credential',
  agentPrivateKey: 'agent_private_key',
} as const;

type RawConfig = Record<string, any>;

function readRaw(env: NodeJS.ProcessEnv): RawConfig | null {
  const file = getArcConfigPath(env);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function writeRaw(config: RawConfig, env: NodeJS.ProcessEnv): void {
  const file = getArcConfigPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash never leaves a half-written config.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function secretsInKeychain(config: { secretsIn?: unknown } | null | undefined): boolean {
  return config?.secretsIn === 'keychain';
}

/** Every plaintext secret a config holds, keyed by its keychain name. */
function plaintextSecrets(config: RawConfig): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof config.apiKey === 'string' && config.apiKey) out.set(SECRET_KEYS.apiKey, config.apiKey);
  if (typeof config.encryptionPassword === 'string' && config.encryptionPassword) {
    out.set(SECRET_KEYS.encryptionPassword, config.encryptionPassword);
  }
  for (const [syncId, budget] of Object.entries(config.budgets ?? {})) {
    const pw = (budget as any)?.encryptionPassword;
    if (typeof pw === 'string' && pw) out.set(SECRET_KEYS.budgetPassword(syncId), pw);
  }
  if (Array.isArray(config.customHeaders) && config.customHeaders.length) {
    out.set(SECRET_KEYS.customHeaders, JSON.stringify(config.customHeaders));
  }
  return out;
}

function stripSecrets(config: RawConfig): RawConfig {
  const next = { ...config };
  delete next.apiKey;
  delete next.encryptionPassword;
  if (Array.isArray(next.customHeaders) && next.customHeaders.length) next.hasCustomHeaders = true;
  delete next.customHeaders;
  if (next.budgets && typeof next.budgets === 'object') {
    next.budgets = Object.fromEntries(
      Object.entries(next.budgets).map(([syncId, budget]) => {
        const b = { ...(budget as Record<string, unknown>) };
        if (b.encryptionPassword) b.hasSavedPassword = true;
        delete b.encryptionPassword;
        return [syncId, b];
      })
    );
  }
  next.secretsIn = 'keychain';
  return next;
}

/**
 * Store a config's secrets in the keychain and strip them from the object.
 * Used by every config write once a config is keychain-backed, so a write
 * path that predates the keychain still cannot put a secret back on disk.
 */
export function moveSecretsToKeychain(config: RawConfig, env: NodeJS.ProcessEnv = process.env): RawConfig {
  const secrets = plaintextSecrets(config);
  if (secrets.size === 0) return { ...config, secretsIn: 'keychain' };
  const kc = getKeychain(env);
  if (!kc) throw new Error('No keychain is available on this machine to hold arc secrets.');
  for (const [key, value] of secrets) kc.set(key, value);
  return stripSecrets(config);
}

export type MigrationResult =
  | { status: 'none' }
  | { status: 'already' }
  | { status: 'migrated'; moved: number; backend: string }
  | { status: 'unavailable'; reason: string };

let warned = false;

/**
 * One-time move of plaintext secrets into the keychain. Safe to call on every
 * start: a config that is already keychain-backed with no plaintext is a
 * no-op that does not touch the keychain at all.
 */
export function migrateSecretsToKeychain(env: NodeJS.ProcessEnv = process.env): MigrationResult {
  let config: RawConfig | null;
  try {
    config = readRaw(env);
  } catch {
    return { status: 'none' }; // config-store reports a malformed file with a better message
  }
  if (!config) return { status: 'none' };
  const secrets = plaintextSecrets(config);
  if (secrets.size === 0) return secretsInKeychain(config) ? { status: 'already' } : { status: 'none' };

  const kc = getKeychain(env);
  if (!kc) return warnUnavailable(env, 'no OS keychain on this machine');

  try {
    for (const [key, value] of secrets) {
      kc.set(key, value);
      if (kc.get(key) !== value) throw new Error(`${key} did not read back`);
    }
  } catch (error) {
    return warnUnavailable(env, error instanceof Error ? error.message : String(error));
  }

  writeRaw(stripSecrets(config), env);
  return { status: 'migrated', moved: secrets.size, backend: kc.name };
}

function warnUnavailable(env: NodeJS.ProcessEnv, reason: string): MigrationResult {
  // Once per machine, not once per command: MCP servers start often.
  const marker = path.join(getArcHome(env), '.keychain-warned');
  if (!warned && !fs.existsSync(marker)) {
    warned = true;
    process.stderr.write(
      `arc: could not move your Actual password into the keychain (${reason}); it stays in ${getArcConfigPath(env)}.\n`
    );
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, new Date().toISOString());
    } catch { /* best effort */ }
  }
  return { status: 'unavailable', reason };
}

// ── reads used by config-store / credential-store ───────────────────────────

export function keychainApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readSecret(SECRET_KEYS.apiKey, env) ?? undefined;
}

export function keychainEncryptionPassword(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readSecret(SECRET_KEYS.encryptionPassword, env) ?? undefined;
}

export function keychainBudgetPassword(syncId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readSecret(SECRET_KEYS.budgetPassword(syncId), env) ?? undefined;
}

/** The keychain's custom headers, or undefined when none (or unreadable JSON). */
export function keychainCustomHeaders(env: NodeJS.ProcessEnv = process.env): { name: string; value: string }[] | undefined {
  const raw = readSecret(SECRET_KEYS.customHeaders, env);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function deleteKeychainSecret(key: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    getKeychain(env)?.delete(key);
  } catch { /* nothing stored, or nothing reachable */ }
}

/** Remove every Actual secret from config and keychain (unpair). */
export function wipeActualSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const config = readRaw(env);
  deleteKeychainSecret(SECRET_KEYS.apiKey, env);
  deleteKeychainSecret(SECRET_KEYS.encryptionPassword, env);
  deleteKeychainSecret(SECRET_KEYS.customHeaders, env);
  for (const syncId of Object.keys(config?.budgets ?? {})) {
    deleteKeychainSecret(SECRET_KEYS.budgetPassword(syncId), env);
  }
  if (config) {
    const stripped = stripSecrets(config);
    delete stripped.hasCustomHeaders;
    for (const budget of Object.values(stripped.budgets ?? {})) (budget as any).hasSavedPassword = false;
    writeRaw(stripped, env);
  }
}
