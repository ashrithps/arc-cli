import fs from 'fs';
import path from 'path';
import { getArcConfigPath } from './runtime-paths.js';
import type { RuntimeConfig } from './types.js';

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
  const apiUrl = env.ACTUAL_SERVER_URL ?? saved?.apiUrl;
  const apiKey = env.ACTUAL_PASSWORD ?? saved?.apiKey;

  if (!apiUrl) throw new Error('Missing runtime config value: apiUrl');
  if (!apiKey) throw new Error('Missing runtime config value: apiKey');

  return {
    apiUrl,
    apiKey,
    displayUrl: env.ACTUAL_DISPLAY_URL ?? saved?.displayUrl,
    defaultSyncId: env.ACTUAL_BUDGET_SYNC_ID ?? saved?.defaultSyncId,
    defaultBudgetName: env.ACTUAL_BUDGET_NAME ?? saved?.defaultBudgetName,
    encryptionPassword: env.ACTUAL_ENCRYPTION_PASSWORD ?? saved?.encryptionPassword,
    budgets: saved?.budgets,
  };
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const filePath = getArcConfigPath(env);
  const saved = readJsonFile(filePath);
  return resolveRuntimeConfig(saved == null ? null : validateRuntimeConfig(saved, filePath), env);
}

export function saveRuntimeConfig(config: RuntimeConfig): void {
  writeJsonFile(getArcConfigPath(), config);
}
