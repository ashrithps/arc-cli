import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import type { Payee } from '../types.js';
import { validateId, validateName } from '../utils/validation.js';

export async function listPayees(client: ActualClient): Promise<Payee[]> {
  client.ensureConnected();
  return await client.api.getPayees();
}

export async function createPayee(
  client: ActualClient,
  writer: SafeWriter,
  name: string
): Promise<string> {
  validateName(name);

  const result = await writer.write(
    `Create payee: ${name}`,
    () => client.api.createPayee({ name })
  );

  if (!result.success) throw new Error(result.error);
  return result.data;
}

export async function updatePayee(
  client: ActualClient,
  writer: SafeWriter,
  id: string,
  fields: Partial<Payee>
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Update payee: ${id}`,
    () => client.api.updatePayee(id, fields)
  );

  if (!result.success) throw new Error(result.error);
}

export async function deletePayee(
  client: ActualClient,
  writer: SafeWriter,
  id: string
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Delete payee: ${id}`,
    () => client.api.deletePayee(id)
  );

  if (!result.success) throw new Error(result.error);
}

export async function findPayeeByName(client: ActualClient, name: string): Promise<Payee | undefined> {
  const payees = await listPayees(client);
  const lower = name.toLowerCase();
  return payees.find(p => p.name.toLowerCase() === lower)
    || payees.find(p => p.name.toLowerCase().includes(lower));
}

export async function resolvePayeeId(client: ActualClient, nameOrId: string): Promise<string> {
  const payees = await listPayees(client);

  const byId = payees.find(p => p.id === nameOrId);
  if (byId) return byId.id;

  const lower = nameOrId.toLowerCase();
  const byName = payees.find(p => p.name.toLowerCase() === lower);
  if (byName) return byName.id;

  const partial = payees.find(p => p.name.toLowerCase().includes(lower));
  if (partial) return partial.id;

  throw new Error(`Payee not found: "${nameOrId}". Use 'payees list' to see available payees.`);
}

export async function getTransferPayees(client: ActualClient): Promise<Payee[]> {
  const payees = await listPayees(client);
  return payees.filter(p => p.transfer_acct);
}

/**
 * Merge multiple payees into a target payee.
 * All transactions from mergeIds will be reassigned to targetId.
 * The merged payees are deleted after reassignment.
 */
export async function mergePayees(
  client: ActualClient,
  writer: SafeWriter,
  targetId: string,
  mergeIds: string[]
): Promise<void> {
  validateId(targetId);
  if (mergeIds.length === 0) throw new Error('No payees to merge.');

  // Validate all IDs exist
  const payees = await listPayees(client);
  const target = payees.find(p => p.id === targetId);
  if (!target) throw new Error(`Target payee not found: ${targetId}`);

  for (const id of mergeIds) {
    if (id === targetId) throw new Error('Cannot merge a payee into itself.');
    if (!payees.find(p => p.id === id)) throw new Error(`Payee to merge not found: ${id}`);
  }

  const result = await writer.write(
    `Merge ${mergeIds.length} payees into ${target.name}`,
    () => (client.api as any).mergePayees(targetId, mergeIds)
  );

  if (!result.success) throw new Error(result.error);
}

/**
 * Find a payee by name, or create it if it doesn't exist.
 * Returns the payee ID.
 */
export async function findOrCreatePayee(
  client: ActualClient,
  writer: SafeWriter,
  name: string
): Promise<string> {
  validateName(name);
  const existing = await findPayeeByName(client, name);
  if (existing) return existing.id;
  return await createPayee(client, writer, name);
}

/**
 * Get common/frequently used payees by counting transactions.
 */
export async function getCommonPayees(
  client: ActualClient,
  limit: number = 20
): Promise<{ id: string; name: string; count: number }[]> {
  client.ensureConnected();

  const payees = await listPayees(client);
  const accounts = await client.api.getAccounts();

  // Count transactions per payee across all accounts
  const counts: Record<string, number> = {};
  for (const acct of accounts) {
    try {
      const txns = await client.api.getTransactions(acct.id);
      for (const t of txns) {
        if (t.payee) counts[t.payee] = (counts[t.payee] || 0) + 1;
      }
    } catch {}
  }

  // Map to payee names and sort by count
  return payees
    .filter(p => !p.transfer_acct && counts[p.id])
    .map(p => ({ id: p.id, name: p.name, count: counts[p.id] || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
