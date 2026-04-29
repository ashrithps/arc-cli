import type { InstallPayload } from './types.js';
import { assertArcHost } from './utils/arc-host.js';

function readString(value: unknown, field: keyof InstallPayload, required = false): string | undefined {
  if (value == null) {
    if (required) {
      throw new Error(`Invalid payload: "${field}" is required`);
    }
    return undefined;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid payload: "${field}" must be a non-empty string`);
  }

  return value;
}

export function parseInstallPayload(raw: string | InstallPayload): InstallPayload {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
    throw new Error('Invalid payload: root value must be an object');
  }

  const apiUrl = readString(parsed.apiUrl, 'apiUrl', true)!;
  assertArcHost(apiUrl, 'payload.apiUrl');

  return {
    apiUrl,
    apiKey: readString(parsed.apiKey, 'apiKey', true)!,
    syncId: readString(parsed.syncId, 'syncId', true)!,
    displayUrl: readString(parsed.displayUrl, 'displayUrl'),
    budgetName: readString(parsed.budgetName, 'budgetName'),
    encryptionPassword: readString(parsed.encryptionPassword, 'encryptionPassword'),
    generatedAt: readString(parsed.generatedAt, 'generatedAt'),
    sourceApp: readString(parsed.sourceApp, 'sourceApp'),
  };
}
