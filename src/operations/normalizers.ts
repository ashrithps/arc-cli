/**
 * Shared normalization helpers for rule and schedule payloads.
 *
 * These resolve human-friendly name references (accounts, categories,
 * payees) into Actual UUIDs before a write operation is handed to the
 * underlying API. Extracted so both the CLI dispatcher (`src/index.ts`)
 * and the MCP server (`src/mcp/server.ts`) can share the same logic
 * without creating an import cycle between them.
 */

import type { ActualClient } from '../client.js';
import * as accounts from './accounts.js';
import * as categories from './categories.js';
import * as payees from './payees.js';

/**
 * Strict UUID v-any 36-char check. Used to decide whether a user-supplied
 * reference (category, payee, etc.) is already an Actual UUID and should be
 * passed through verbatim, as opposed to a human-typed name that needs
 * resolution. Tighter than the old `/^[a-f0-9-]{8,}$/` heuristic which would
 * false-positive on literal names like "deadbeef".
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isLikelyUuid(value: string): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

export async function normalizeSchedulePayload(
  client: ActualClient,
  payload: any
): Promise<any> {
  const normalized = { ...payload };
  if (normalized.account) normalized.account = await accounts.resolveAccountId(client, normalized.account);
  if (normalized._account) normalized._account = await accounts.resolveAccountId(client, normalized._account);
  if (normalized.category) normalized.category = await categories.resolveCategoryId(client, normalized.category);
  if (normalized._category) normalized._category = await categories.resolveCategoryId(client, normalized._category);
  if (normalized.payee) normalized.payee = await payees.resolvePayeeId(client, normalized.payee);
  if (normalized._payee) normalized._payee = await payees.resolvePayeeId(client, normalized._payee);
  return normalized;
}

async function normalizeRuleFieldValue(
  client: ActualClient,
  field: string,
  value: any
): Promise<any> {
  const resolveOne = async (entry: any): Promise<any> => {
    if (typeof entry !== 'string') return entry;
    if (field === 'account') return accounts.resolveAccountId(client, entry);
    if (field === 'category') return categories.resolveCategoryId(client, entry);
    if (field === 'payee') return payees.resolvePayeeId(client, entry);
    return entry;
  };

  if (Array.isArray(value)) {
    return Promise.all(value.map(resolveOne));
  }

  return resolveOne(value);
}

export async function normalizeRulePayload(
  client: ActualClient,
  payload: any
): Promise<any> {
  const normalized = {
    ...payload,
    conditions: Array.isArray(payload.conditions) ? [...payload.conditions] : payload.conditions,
    actions: Array.isArray(payload.actions) ? [...payload.actions] : payload.actions,
  };

  if (Array.isArray(normalized.conditions)) {
    normalized.conditions = await Promise.all(normalized.conditions.map(async (condition: any) => {
      if (!condition || !['account', 'category', 'payee'].includes(condition.field)) {
        return condition;
      }
      return {
        ...condition,
        value: await normalizeRuleFieldValue(client, condition.field, condition.value),
      };
    }));
  }

  if (Array.isArray(normalized.actions)) {
    normalized.actions = await Promise.all(normalized.actions.map(async (action: any) => {
      if (!action || !['account', 'category', 'payee'].includes(action.field)) {
        return action;
      }
      return {
        ...action,
        value: await normalizeRuleFieldValue(client, action.field, action.value),
      };
    }));
  }

  return normalized;
}
