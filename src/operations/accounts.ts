import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import type { Account } from '../types.js';
import { validateId, validateName } from '../utils/validation.js';

/**
 * Compute an account's balance by summing all its non-child transactions.
 * Splits have parent transactions whose amount equals the total; we skip
 * children (is_child) to avoid double-counting.
 *
 * @actual-app/api's getAccounts() returns accounts WITHOUT a balance
 * field; there is no balance_current or similar on the raw Actual record.
 * Balances must be computed from the transaction ledger.
 */
async function computeAccountBalance(client: ActualClient, accountId: string): Promise<number> {
  try {
    const txns = await client.api.getTransactions(accountId);
    let balance = 0;
    for (const t of txns) {
      if (!t.is_child) balance += t.amount ?? 0;
    }
    return balance;
  } catch {
    return 0;
  }
}

export async function listAccounts(client: ActualClient): Promise<Array<Account & { balance: number }>> {
  client.ensureConnected();
  const accounts = await client.api.getAccounts();
  // Compute balances in parallel — each getTransactions call is a SQLite
  // read, so parallelism is cheap and keeps the MCP tool latency low.
  const balances = await Promise.all(
    accounts.map((a: Account) => computeAccountBalance(client, a.id))
  );
  return accounts.map((a: Account, i: number) => ({ ...a, balance: balances[i] }));
}

export async function getAccountBalance(client: ActualClient, accountId: string): Promise<number> {
  client.ensureConnected();
  validateId(accountId);
  const accounts = await client.api.getAccounts();
  const account = accounts.find((a: any) => a.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);
  return computeAccountBalance(client, account.id);
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
