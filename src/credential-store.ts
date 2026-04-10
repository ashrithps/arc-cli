import fs from 'fs';
import path from 'path';
import { getArcConfigPath } from './runtime-paths.js';
import type { BudgetFile, InstallPayload, RuntimeBudgetProfile, RuntimeConfig } from './types.js';

type StoredRuntimeConfig = Partial<RuntimeConfig>;

function readStoredConfig(env: NodeJS.ProcessEnv = process.env): StoredRuntimeConfig {
  const filePath = getArcConfigPath(env);
  if (!fs.existsSync(filePath)) return {};

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return {};

  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
    throw new Error(`Invalid runtime config file at ${filePath}: root value must be a JSON object`);
  }

  return parsed as StoredRuntimeConfig;
}

function writeStoredConfig(config: StoredRuntimeConfig, env: NodeJS.ProcessEnv = process.env): void {
  const filePath = getArcConfigPath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function updateStoredConfig(
  updater: (config: StoredRuntimeConfig) => StoredRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env
): StoredRuntimeConfig {
  const next = updater(readStoredConfig(env));
  writeStoredConfig(next, env);
  return next;
}

function ensureBudgets(config: StoredRuntimeConfig): NonNullable<StoredRuntimeConfig['budgets']> {
  if (!config.budgets || typeof config.budgets !== 'object') {
    config.budgets = {};
  }
  return config.budgets;
}

function mergeBudgetProfile(
  current: RuntimeBudgetProfile | undefined,
  next: RuntimeBudgetProfile
): RuntimeBudgetProfile {
  return {
    syncId: next.syncId ?? current?.syncId,
    budgetName: next.budgetName ?? current?.budgetName,
    isEncrypted: next.isEncrypted ?? current?.isEncrypted,
    hasSavedPassword: next.hasSavedPassword ?? current?.hasSavedPassword,
    encryptionPassword: next.encryptionPassword ?? current?.encryptionPassword,
  };
}

export function getInstalledConfig(env: NodeJS.ProcessEnv = process.env): StoredRuntimeConfig {
  return readStoredConfig(env);
}

export function getBudgetMetadata(
  syncId: string,
  env: NodeJS.ProcessEnv = process.env
): RuntimeBudgetProfile | undefined {
  return readStoredConfig(env).budgets?.[syncId];
}

export function getBudgetPassword(syncId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return getBudgetMetadata(syncId, env)?.encryptionPassword;
}

export function saveBudgetMetadata(
  profile: RuntimeBudgetProfile & { syncId: string },
  env: NodeJS.ProcessEnv = process.env
): RuntimeBudgetProfile {
  let savedProfile!: RuntimeBudgetProfile;

  updateStoredConfig(config => {
    const budgets = ensureBudgets(config);
    savedProfile = mergeBudgetProfile(budgets[profile.syncId], {
      syncId: profile.syncId,
      budgetName: profile.budgetName,
      isEncrypted: profile.isEncrypted,
      hasSavedPassword: profile.hasSavedPassword,
      encryptionPassword: profile.encryptionPassword,
    });
    budgets[profile.syncId] = savedProfile;
    return config;
  }, env);

  return savedProfile;
}

export function saveBudgetPassword(
  profile: RuntimeBudgetProfile & { syncId: string },
  password: string,
  env: NodeJS.ProcessEnv = process.env
): RuntimeBudgetProfile {
  return saveBudgetMetadata({
    ...profile,
    hasSavedPassword: true,
    encryptionPassword: password,
  }, env);
}

export function persistBudgetCatalog(
  budgets: BudgetFile[],
  env: NodeJS.ProcessEnv = process.env
): RuntimeBudgetProfile[] {
  const saved = readStoredConfig(env);
  const existingBudgets = saved.budgets ?? {};
  const profiles: RuntimeBudgetProfile[] = [];

  updateStoredConfig(config => {
    const nextBudgets = ensureBudgets(config);
    for (const budget of budgets) {
      const syncId = budget.groupId || budget.cloudFileId;
      if (!syncId) continue;

      const existing = nextBudgets[syncId] ?? existingBudgets[syncId];
      const profile = mergeBudgetProfile(existing, {
        syncId,
        budgetName: budget.name,
        isEncrypted: !!budget.encryptKeyId,
        hasSavedPassword: !!existing?.encryptionPassword,
        encryptionPassword: existing?.encryptionPassword,
      });
      nextBudgets[syncId] = profile;
      profiles.push(profile);
    }
    return config;
  }, env);

  return profiles;
}

export function persistSelectedBudget(
  profile: RuntimeBudgetProfile & { syncId: string },
  env: NodeJS.ProcessEnv = process.env
): void {
  updateStoredConfig(config => {
    config.defaultSyncId = profile.syncId;
    config.defaultBudgetName = profile.budgetName;
    if (profile.encryptionPassword !== undefined) {
      config.encryptionPassword = profile.encryptionPassword;
    } else {
      delete config.encryptionPassword;
    }
    return config;
  }, env);

  saveBudgetMetadata(profile, env);
}

export function saveBootstrapPayload(
  payload: InstallPayload,
  env: NodeJS.ProcessEnv = process.env
): void {
  updateStoredConfig(config => {
    config.apiUrl = payload.apiUrl;
    config.apiKey = payload.apiKey;
    config.displayUrl = payload.displayUrl;
    config.defaultSyncId = payload.syncId;
    config.defaultBudgetName = payload.budgetName;
    if (payload.encryptionPassword) {
      config.encryptionPassword = payload.encryptionPassword;
    } else {
      delete config.encryptionPassword;
    }

    const budgets = ensureBudgets(config);
    budgets[payload.syncId] = mergeBudgetProfile(budgets[payload.syncId], {
      syncId: payload.syncId,
      budgetName: payload.budgetName,
      isEncrypted: !!payload.encryptionPassword,
      hasSavedPassword: !!payload.encryptionPassword,
      encryptionPassword: payload.encryptionPassword,
    });

    return config;
  }, env);
}
