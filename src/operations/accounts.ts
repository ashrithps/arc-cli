import type { ActualClient } from '../client.js';
import { AmbiguousRefError, pickOne } from '../utils/resolve-ref.js';
import type { SafeWriter } from '../safe-writer.js';
import type { Account } from '../types.js';
import { validateId, validateName } from '../utils/validation.js';
import { getAccountFxMap } from './fx.js';

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

export async function listAccounts(client: ActualClient): Promise<Array<Account & {
  balance: number;
  currency?: string;
  fxRate?: number;
  nativeBalance?: number;
}>> {
  client.ensureConnected();
  const accounts = await client.api.getAccounts();
  // Compute balances in parallel — each getTransactions call is a SQLite
  // read, so parallelism is cheap and keeps the MCP tool latency low.
  const [balances, fxMap] = await Promise.all([
    Promise.all(accounts.map((a: Account) => computeAccountBalance(client, a.id))),
    getAccountFxMap(client),
  ]);
  return accounts.map((a: Account, i: number) => {
    const baseBalance = balances[i];
    const fx = fxMap[a.id];
    if (!fx) return { ...a, balance: baseBalance };
    // Recover the native-currency balance by dividing the stored base
    // amount by the FX rate. This is approximate because every individual
    // transaction was rounded to the nearest base-currency cent before
    // storage, but it's accurate enough for "show me my account balance
    // in INR/EUR/etc" use cases. Always trust `balance` (base cents) when
    // doing math; `nativeBalance` is for display.
    return {
      ...a,
      balance: baseBalance,
      currency: fx.currency,
      fxRate: fx.rate,
      nativeBalance: Math.round(baseBalance / fx.rate),
    };
  });
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

/** Several accounts answer to one reference: refused, with their ids (src/utils/resolve-ref.ts). */
export class AmbiguousAccountError extends AmbiguousRefError {
  constructor(ref: string, matches: Array<{ id: string; name: string; closed?: boolean | number | null; offbudget?: boolean | number | null }>) {
    super('account', ref, matches.map(describeAccount));
    this.message = this.message.replace(/\.$/, ', e.g. --account <id>.');
    this.name = 'AmbiguousAccountError';
  }
}

function describeAccount(a: { id: string; name: string; closed?: boolean | number | null; offbudget?: boolean | number | null }): string {
  return `${a.name} (id ${a.id}${a.closed ? ', closed' : ''}${a.offbudget ? ', off budget' : ''})`;
}

/** The one account a reference names: id, else exact name, else part of a name; more than one is refused. */
export function pickAccount<A extends { id: string; name: string }>(accounts: readonly A[], nameOrId: string): A {
  return pickOne(accounts, nameOrId, {
    kind: 'account',
    nameOf: (a) => a.name,
    ambiguous: (matches) => new AmbiguousAccountError(nameOrId, matches),
    notFound: () => new Error(`Account not found: "${nameOrId}". Available: ${accounts.map((a) => a.name).join(', ')}`),
  });
}

export async function resolveAccountId(client: ActualClient, nameOrId: string): Promise<string> {
  const accounts = (await client.api.getAccounts()) as Array<{ id: string; name: string }>;
  return pickAccount(accounts, nameOrId).id;
}
