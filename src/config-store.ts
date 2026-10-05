import fs from 'fs';
import path from 'path';
import { getArcConfigPath } from './runtime-paths.js';
import type { RuntimeConfig } from './types.js';
import { assertAllowedHost, assertArcHost, isArcManagedUrl } from './utils/arc-host.js';
import { readServerHeaders } from './net/server-headers.js';
import {
  keychainApiKey,
  keychainBudgetPassword,
  keychainCustomHeaders,
  keychainEncryptionPassword,
  secretsInKeychain,
} from './agent-controls/credentials.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidConfigError(filePath: string, reason: string): Error {
  return new Error(`Invalid runtime config file at ${filePath}: ${reason}`);
}

function readJsonFile(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalidConfigError(filePath, `could not parse JSON (${message})`);
  }
}

function readStringField(
  value: unknown,
  field: string,
  filePath: string,
  required = false
): string | undefined {
  if (value == null) {
    if (required) {
      throw invalidConfigError(filePath, `field "${field}" must be a non-empty string`);
    }
    return undefined;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidConfigError(filePath, `field "${field}" must be a non-empty string`);
  }

  return value;
}

function readBooleanField(value: unknown, field: string, filePath: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') {
    throw invalidConfigError(filePath, `field "${field}" must be a boolean`);
  }
  return value;
}

function readRuntimeBudgetProfile(value: unknown, budgetId: string, filePath: string): NonNullable<RuntimeConfig['budgets']>[string] {
  if (!isPlainObject(value)) {
    throw invalidConfigError(filePath, `budgets["${budgetId}"] must be an object`);
  }

  return {
    syncId: readStringField(value.syncId, `budgets["${budgetId}"].syncId`, filePath),
    budgetName: readStringField(value.budgetName, `budgets["${budgetId}"].budgetName`, filePath),
    isEncrypted: readBooleanField(value.isEncrypted, `budgets["${budgetId}"].isEncrypted`, filePath),
    hasSavedPassword: readBooleanField(value.hasSavedPassword, `budgets["${budgetId}"].hasSavedPassword`, filePath),
    encryptionPassword: readStringField(value.encryptionPassword, `budgets["${budgetId}"].encryptionPassword`, filePath),
  };
}

function validateRuntimeConfig(value: unknown, filePath: string): Partial<RuntimeConfig> {
  if (!isPlainObject(value)) {
    throw invalidConfigError(filePath, 'root value must be a JSON object');
  }

  const config: Partial<RuntimeConfig> = {};

  if ('apiUrl' in value) config.apiUrl = readStringField(value.apiUrl, 'apiUrl', filePath, true);
  if ('apiKey' in value) config.apiKey = readStringField(value.apiKey, 'apiKey', filePath, true);
  if ('displayUrl' in value) config.displayUrl = readStringField(value.displayUrl, 'displayUrl', filePath);
  if ('defaultSyncId' in value) config.defaultSyncId = readStringField(value.defaultSyncId, 'defaultSyncId', filePath);
  if ('defaultBudgetName' in value) config.defaultBudgetName = readStringField(value.defaultBudgetName, 'defaultBudgetName', filePath);
  if ('encryptionPassword' in value) config.encryptionPassword = readStringField(value.encryptionPassword, 'encryptionPassword', filePath);
  if (value.secretsIn === 'keychain') config.secretsIn = 'keychain';
  if ('customHeaders' in value) {
    try {
      config.customHeaders = readServerHeaders(value.customHeaders, 'customHeaders');
    } catch (error) {
      throw invalidConfigError(filePath, error instanceof Error ? error.message : String(error));
    }
  }
  if ('hasCustomHeaders' in value) config.hasCustomHeaders = readBooleanField(value.hasCustomHeaders, 'hasCustomHeaders', filePath);
  if ('cliLicense' in value) config.cliLicense = readStringField(value.cliLicense, 'cliLicense', filePath);

  if ('budgets' in value) {
    if (!isPlainObject(value.budgets)) {
      throw invalidConfigError(filePath, 'field "budgets" must be an object map');
    }

    config.budgets = {};
    for (const [budgetId, budgetValue] of Object.entries(value.budgets)) {
      config.budgets[budgetId] = readRuntimeBudgetProfile(budgetValue, budgetId, filePath);
    }
  }

  return config;
}

function writeJsonFile(filePath: string, config: RuntimeConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function resolveRuntimeConfig(
  saved: Partial<RuntimeConfig> | null,
  env: NodeJS.ProcessEnv
): RuntimeConfig {
  const inKeychain = secretsInKeychain(saved);
  const apiUrl = env.ACTUAL_SERVER_URL ?? saved?.apiUrl;
  // Environment overrides win over both the file and the keychain.
  const apiKey = env.ACTUAL_PASSWORD ?? saved?.apiKey ?? (inKeychain ? keychainApiKey(env) : undefined);

  if (!apiUrl) throw new Error('Missing runtime config value: apiUrl');
  if (!apiKey) {
    if (inKeychain) {
      throw new Error(
        "arc's server password is in the keychain, but the keychain couldn't be read. " +
          (process.platform === 'darwin'
            ? 'Unlock it (security unlock-keychain) — it is locked over SSH and under cron — or set ACTUAL_PASSWORD.'
            : 'Make sure the Secret Service (gnome-keyring or KeePassXC) is running and unlocked, or set ACTUAL_PASSWORD.')
      );
    }
    throw new Error('Missing runtime config value: apiKey');
  }

  // apiUrl is the host we actually send credentials to, so it is the one that
  // must satisfy the host rule on every load — not just at bootstrap time in
  // parseInstallPayload. Without this, ACTUAL_SERVER_URL (or a hand-edited
  // ~/.arc-cli/config.json) silently bypasses the lock. A self-hosted host
  // needs a current licence signed for it; managed hosts are unchanged.
  const cliLicense = env.ARC_CLI_LICENSE ?? saved?.cliLicense;
  assertAllowedHost(apiUrl, env.ACTUAL_SERVER_URL ? 'ACTUAL_SERVER_URL' : 'apiUrl', cliLicense);

  const displayUrl = env.ACTUAL_DISPLAY_URL ?? saved?.displayUrl;
  if (displayUrl) {
    const source = env.ACTUAL_DISPLAY_URL ? 'ACTUAL_DISPLAY_URL' : 'displayUrl';
    // Nothing is sent to displayUrl; it only has to be a URL. Managed installs
    // keep their old, stricter check.
    if (isArcManagedUrl(apiUrl)) assertArcHost(displayUrl, source);
    else if (!URL.canParse(displayUrl)) throw new Error(`Invalid ${source}: "${displayUrl}" is not a valid URL.`);
  }

  const customHeaders = env.ACTUAL_CUSTOM_HEADERS
    ? readServerHeaders(parseJsonEnv(env.ACTUAL_CUSTOM_HEADERS, 'ACTUAL_CUSTOM_HEADERS'), 'ACTUAL_CUSTOM_HEADERS')
    : saved?.customHeaders ?? (inKeychain && saved?.hasCustomHeaders ? keychainCustomHeaders(env) : undefined);

  const defaultSyncId = env.ACTUAL_BUDGET_SYNC_ID ?? saved?.defaultSyncId;
  let budgets = saved?.budgets;
  // Hydrate only the selected budget's password: each keychain read is a
  // subprocess, and the other budgets are read on demand by getBudgetPassword.
  if (inKeychain && defaultSyncId && budgets?.[defaultSyncId] && !budgets[defaultSyncId].encryptionPassword &&
      budgets[defaultSyncId].hasSavedPassword !== false) {
    const pw = keychainBudgetPassword(defaultSyncId, env);
    if (pw) budgets = { ...budgets, [defaultSyncId]: { ...budgets[defaultSyncId], encryptionPassword: pw } };
  }

  return {
    apiUrl,
    apiKey,
    displayUrl,
    defaultSyncId,
    defaultBudgetName: env.ACTUAL_BUDGET_NAME ?? saved?.defaultBudgetName,
    encryptionPassword: env.ACTUAL_ENCRYPTION_PASSWORD ?? saved?.encryptionPassword ??
      (inKeychain ? keychainEncryptionPassword(env) : undefined),
    budgets,
    secretsIn: saved?.secretsIn,
    ...(customHeaders ? { customHeaders } : {}),
    ...(cliLicense ? { cliLicense } : {}),
  };
}

function parseJsonEnv(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${name}: must be JSON, e.g. [{"name":"CF-Access-Client-Id","value":"…"}]`);
  }
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const filePath = getArcConfigPath(env);
  const saved = readJsonFile(filePath);
  return resolveRuntimeConfig(saved == null ? null : validateRuntimeConfig(saved, filePath), env);
}

export function saveRuntimeConfig(config: RuntimeConfig): void {
  writeJsonFile(getArcConfigPath(), config);
}
