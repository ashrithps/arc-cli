import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import type { Account } from '../types.js';
import { validateId, validateName } from '../utils/validation.js';

export async function listAccounts(client: ActualClient): Promise<Account[]> {
  client.ensureConnected();
  return await client.api.getAccounts();
}

export async function getAccountBalance(client: ActualClient, accountId: string): Promise<number> {
  client.ensureConnected();
  validateId(accountId);
  // Use runQuery to get the balance
  const accounts = await client.api.getAccounts();
  const account = accounts.find((a: any) => a.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);
  return (account as any).balance_current ?? 0;
}

export async function createAccount(
  client: ActualClient,
  writer: SafeWriter,
  name: string,
  type?: string,
  offbudget?: boolean,
  initialBalance?: number
): Promise<string> {
  validateName(name);

  const account: any = { name, type: type || 'checking' };
  if (offbudget != null) account.offbudget = offbudget;

  const result = await writer.write(
    `Create account: ${name}`,
    () => client.api.createAccount(account, initialBalance ?? 0)
  );

  if (!result.success) throw new Error(result.error);
  return result.data;
}

export async function updateAccount(
  client: ActualClient,
  writer: SafeWriter,
  id: string,
  fields: Partial<Account>
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Update account: ${id}`,
    () => client.api.updateAccount(id, fields)
  );

  if (!result.success) throw new Error(result.error);
}

export async function closeAccount(
  client: ActualClient,
  writer: SafeWriter,
  id: string,
  transferAccountId?: string,
  transferCategoryId?: string
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Close account: ${id}`,
    () => client.api.closeAccount(id, transferAccountId, transferCategoryId)
  );

  if (!result.success) throw new Error(result.error);
}

export async function reopenAccount(
  client: ActualClient,
  writer: SafeWriter,
  id: string
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Reopen account: ${id}`,
    () => client.api.reopenAccount(id)
  );

  if (!result.success) throw new Error(result.error);
}

export async function deleteAccount(
  client: ActualClient,
  writer: SafeWriter,
  id: string
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Delete account: ${id}`,
    () => client.api.deleteAccount(id)
  );

  if (!result.success) throw new Error(result.error);
}

export async function findAccountByName(client: ActualClient, name: string): Promise<Account | undefined> {
  client.ensureConnected();
  const accounts = await client.api.getAccounts();
  const lower = name.toLowerCase();
  return accounts.find((a: any) => a.name.toLowerCase() === lower);
}

export async function resolveAccountId(client: ActualClient, nameOrId: string): Promise<string> {
  // Try as direct ID first
  const accounts = await client.api.getAccounts();
  const byId = accounts.find((a: any) => a.id === nameOrId);
  if (byId) return byId.id;

  // Try by name (case-insensitive)
  const lower = nameOrId.toLowerCase();
  const byName = accounts.find((a: any) => a.name.toLowerCase() === lower);
  if (byName) return byName.id;

  // Try partial match
  const partial = accounts.find((a: any) => a.name.toLowerCase().includes(lower));
  if (partial) return partial.id;

  throw new Error(`Account not found: "${nameOrId}". Available: ${accounts.map((a: any) => a.name).join(', ')}`);
}
