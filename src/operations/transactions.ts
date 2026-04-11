import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import type { Transaction, TransactionCreate, SubTransaction, ImportResult, Rule } from '../types.js';
import { validateId, validateDate, validateTransaction, validateSplitAmounts } from '../utils/validation.js';

interface FxAccountMetadata {
  currency: string;
  rate: number;
}

function formatFxRate(rate: number): string {
  return Number(rate.toFixed(6)).toString();
}

function formatForeignAmount(cents: number): string {
  return (Math.abs(cents) / 100).toFixed(2);
}

function buildFxTransferNotes(localAmountCents: number, currency: string, rate: number, notes?: string): string {
  const prefix = `${formatForeignAmount(localAmountCents)} ${currency} (FX rate: ${formatFxRate(rate)})`;
  return notes ? `${prefix} • ${notes}` : prefix;
}

function parseFxAccountMetadata(rules: Rule[], accountId: string): FxAccountMetadata | null {
  for (const rule of rules) {
    if (rule.stage !== 'post') continue;
    const hasAccountCondition = rule.conditions?.some(
      c => c.field === 'account' && c.op === 'is' && c.value === accountId
    );
    if (!hasAccountCondition) continue;

    const noteAction = rule.actions?.find(a => a.field === 'notes' && typeof a.value === 'string');
    const amountAction = rule.actions?.find(a => a.field === 'amount');
    const noteTemplate = String(noteAction?.value || noteAction?.options?.template || '');
    const amountTemplate = String(amountAction?.options?.template || amountAction?.value || '');

    const noteMatch = noteTemplate.match(/\}\}\s+([A-Z]{3})\s+\(FX rate:\s*([0-9.]+)\)/);
    const amountMatch = amountTemplate.match(/mul amount\s+([0-9.]+)/);
    if (!noteMatch || !amountMatch) continue;

    const currency = noteMatch[1];
    const noteRate = parseFloat(noteMatch[2]);
    const amountRate = parseFloat(amountMatch[1]);
    if (!Number.isFinite(noteRate) || !Number.isFinite(amountRate)) continue;

    return { currency, rate: amountRate || noteRate };
  }

  return null;
}

export async function listTransactions(
  client: ActualClient,
  accountId: string,
  startDate?: string,
  endDate?: string
): Promise<Transaction[]> {
  client.ensureConnected();
  validateId(accountId);

  if (startDate) validateDate(startDate);
  if (endDate) validateDate(endDate);

  return await client.api.getTransactions(accountId, startDate, endDate);
}

export async function addTransaction(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string,
  tx: TransactionCreate
): Promise<string> {
  validateId(accountId);
  // @actual-app/api's `addTransactions` IPC returns the literal string "ok"
  // — it does NOT return the assigned transaction ids. Actual does respect
  // an `id` field on the input though, so we generate a UUID client-side
  // and return it. This is the same pattern createSplitTransaction and
  // createTransfer below already use.
  const id = crypto.randomUUID();
  const validated = validateTransaction({ ...tx, id, cleared: tx.cleared ?? true });

  const result = await writer.write(
    `Add transaction: ${tx.payee_name || tx.payee || 'unknown'} on ${tx.date}`,
    () => client.api.addTransactions(accountId, [validated])
  );

  if (!result.success) throw new Error(result.error);
  return id;
}

export async function importTransaction(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string,
  tx: TransactionCreate
): Promise<string> {
  validateId(accountId);
  const validated = validateTransaction({ ...tx, cleared: tx.cleared ?? true });

  const result = await writer.write(
    `Import transaction: ${tx.payee_name || tx.payee || 'unknown'} on ${tx.date}`,
    () => (client.api as any).importTransactions(accountId, [validated])
  );

  if (!result.success) throw new Error(result.error);
  return Array.isArray(result.data?.errors) && result.data.errors.length > 0
    ? ''
    : (result.data?.added || result.data?.updated ? 'ok' : '');
}

export async function addTransactions(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string,
  txs: TransactionCreate[],
  opts?: { learnCategories?: boolean; runTransfers?: boolean }
): Promise<string[]> {
  validateId(accountId);
  // Generate ids client-side: addTransactions IPC returns "ok" not ids.
  // Actual respects the `id` field on input transactions, so we assign
  // a UUID per row and return them in order.
  const ids: string[] = [];
  const validated = txs.map(tx => {
    const id = crypto.randomUUID();
    ids.push(id);
    return validateTransaction({ ...tx, id, cleared: tx.cleared ?? true });
  });

  const result = await writer.write(
    `Add ${validated.length} transactions`,
    () => client.api.addTransactions(accountId, validated, opts)
  );

  if (!result.success) throw new Error(result.error);
  return ids;
}

export async function importTransactions(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string,
  txs: TransactionCreate[]
): Promise<ImportResult> {
  validateId(accountId);
  const validated = txs.map(tx => validateTransaction({ ...tx, cleared: tx.cleared ?? true }));

  const result = await writer.write(
    `Import ${validated.length} transactions`,
    () => (client.api as any).importTransactions(accountId, validated)
  );

  if (!result.success) throw new Error(result.error);
  return result.data || { errors: [], added: 0, updated: 0 };
}

export async function updateTransaction(
  client: ActualClient,
  writer: SafeWriter,
  id: string,
  fields: Partial<Transaction>
): Promise<void> {
  validateId(id);

  // Safety: prevent modifying transfer linkage directly
  if ('transfer_id' in fields) {
    throw new Error('Cannot modify transfer_id directly. Use createTransfer instead.');
  }

  const result = await writer.write(
    `Update transaction: ${id}`,
    () => client.api.updateTransaction(id, fields)
  );

  if (!result.success) throw new Error(result.error);
}

export async function deleteTransaction(
  client: ActualClient,
  writer: SafeWriter,
  id: string
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Delete transaction: ${id}`,
    () => client.api.deleteTransaction(id)
  );

  if (!result.success) throw new Error(result.error);
}

/**
 * Create a split transaction with proper parent/child structure.
 *
 * Subtransactions can be:
 * - Regular: { amount, category, notes, payee? }
 * - Transfer: { amount, category?, notes, transfer_account: "Account Name" }
 *
 * Transfer splits create a linked transfer pair:
 * - Child in source account (is_child=true, parent_id linked, transfer_id linked)
 * - Entry in destination account (transfer_id linked back)
 */
export async function createSplitTransaction(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string,
  parent: {
    date: string;
    payee_name?: string;
    payee?: string;
    notes?: string;
    cleared?: boolean;
  },
  subtransactions: SubTransaction[]
): Promise<string> {
  validateId(accountId);
  validateDate(parent.date);

  if (subtransactions.length === 0) {
    throw new Error('Split transaction requires at least one subtransaction.');
  }

  // Calculate parent amount from subtransactions
  const parentAmount = subtransactions.reduce((sum, s) => sum + s.amount, 0);

  // Check if any subtransaction is a transfer
  const hasTransfers = subtransactions.some(s => s.transfer_account);

  if (!hasTransfers) {
    // Simple split — use addTransactions with subtransactions
    const tx: TransactionCreate = {
      date: parent.date,
      amount: parentAmount,
      payee_name: parent.payee_name,
      payee: parent.payee,
      notes: parent.notes,
      cleared: parent.cleared,
      subtransactions: subtransactions.map(s => ({
        amount: s.amount,
        category: s.category,
        notes: s.notes,
      })),
    };

    const result = await writer.write(
      `Create split transaction: ${parent.payee_name || parent.payee || 'unknown'} (${subtransactions.length} splits)`,
      () => client.api.addTransactions(accountId, [tx])
    );

    if (!result.success) throw new Error(result.error);
    return result.data?.[0] || '';
  }

  // ── Advanced split with transfers ──
  // We must create parent, children, and transfer pairs with correct IDs

  const payees = await client.api.getPayees();
  const accounts = await client.api.getAccounts();

  // Resolve parent payee
  let parentPayeeId = parent.payee;
  if (!parentPayeeId && parent.payee_name) {
    const found = payees.find((p: any) => p.name === parent.payee_name);
    parentPayeeId = found?.id;
  }

  const parentId = crypto.randomUUID();
  const allTxs: { accountId: string; tx: any }[] = [];

  // 1. Parent transaction
  allTxs.push({
    accountId,
    tx: {
      id: parentId,
      date: parent.date,
      amount: parentAmount,
      payee: parentPayeeId,
      payee_name: parent.payee_name,
      notes: parent.notes,
      cleared: parent.cleared ?? true,
      is_parent: true,
      is_child: false,
    },
  });

  // 2. Child transactions
  for (const sub of subtransactions) {
    const childId = crypto.randomUUID();

    if (sub.transfer_account) {
      // Transfer child — find destination account and its transfer payee
      const destAccount = accounts.find((a: any) =>
        a.name === sub.transfer_account || a.id === sub.transfer_account
      );
      if (!destAccount) {
        throw new Error(`Transfer account not found: "${sub.transfer_account}"`);
      }

      const transferPayee = payees.find((p: any) => p.transfer_acct === destAccount.id);
      if (!transferPayee) {
        throw new Error(`No transfer payee found for account: "${sub.transfer_account}"`);
      }

      // Find reverse transfer payee (for destination side)
      const reversePayee = payees.find((p: any) => p.transfer_acct === accountId);

      const destTxId = crypto.randomUUID();

      // Source side (child of parent, in source account)
      allTxs.push({
        accountId,
        tx: {
          id: childId,
          date: parent.date,
          amount: sub.amount,
          payee: transferPayee.id,
          category: sub.category,
          notes: sub.notes,
          cleared: parent.cleared ?? true,
          is_parent: false,
          is_child: true,
          parent_id: parentId,
          transfer_id: destTxId,
        },
      });

      // Destination side (standalone in dest account)
      allTxs.push({
        accountId: destAccount.id,
        tx: {
          id: destTxId,
          date: parent.date,
          amount: -sub.amount, // Reverse sign (inflow)
          payee: reversePayee?.id,
          notes: sub.notes,
          cleared: parent.cleared ?? true,
          is_parent: false,
          is_child: false,
          transfer_id: childId,
        },
      });
    } else {
      // Regular category child
      let childPayeeId = sub.payee || parentPayeeId;
      if (sub.payee && !/^[a-f0-9-]{8,}$/.test(sub.payee)) {
        const found = payees.find((p: any) => p.name === sub.payee);
        childPayeeId = found?.id || parentPayeeId;
      }

      allTxs.push({
        accountId,
        tx: {
          id: childId,
          date: parent.date,
          amount: sub.amount,
          payee: childPayeeId,
          category: sub.category,
          notes: sub.notes,
          cleared: parent.cleared ?? true,
          is_parent: false,
          is_child: true,
          parent_id: parentId,
        },
      });
    }
  }

  // 3. Create all transactions grouped by account
  const byAccount = new Map<string, any[]>();
  for (const item of allTxs) {
    if (!byAccount.has(item.accountId)) byAccount.set(item.accountId, []);
    byAccount.get(item.accountId)!.push(item.tx);
  }

  for (const [acctId, txs] of byAccount) {
    const result = await writer.write(
      `Split ${parent.payee_name || 'unknown'}: ${txs.length} txns in ${acctId.slice(0, 8)}`,
      () => client.api.addTransactions(acctId, txs)
    );
    if (!result.success) throw new Error(result.error);
  }

  return parentId;
}

export async function createTransfer(
  client: ActualClient,
  writer: SafeWriter,
  fromAccountId: string,
  toAccountId: string,
  amount: number,
  date: string,
  notes?: string,
  cleared = true,
  foreignAmount?: number
): Promise<string> {
  validateId(fromAccountId);
  validateId(toAccountId);
  validateDate(date);

  if (fromAccountId === toAccountId) {
    throw new Error('Cannot transfer to the same account.');
  }

  // Resolve transfer payees for both directions so we can create a fully linked pair.
  const payees = await client.api.getPayees();
  const toTransferPayee = payees.find((p: any) => p.transfer_acct === toAccountId);
  const fromTransferPayee = payees.find((p: any) => p.transfer_acct === fromAccountId);

  if (!toTransferPayee) {
    throw new Error(`No transfer payee found for account: ${toAccountId}. Accounts may not be set up for transfers.`);
  }
  if (!fromTransferPayee) {
    throw new Error(`No reverse transfer payee found for account: ${fromAccountId}. Accounts may not be set up for transfers.`);
  }

  const fxMetadata = parseFxAccountMetadata(await client.api.getRules(), toAccountId);
  const destNotes = fxMetadata
    ? buildFxTransferNotes(
        foreignAmount ?? Math.round((Math.abs(amount) / fxMetadata.rate)),
        fxMetadata.currency,
        fxMetadata.rate,
        notes
      )
    : notes;

  const sourceTxId = crypto.randomUUID();
  const destTxId = crypto.randomUUID();

  const sourceTx: TransactionCreate & { id: string; transfer_id: string } = {
    id: sourceTxId,
    date,
    amount: -Math.abs(amount), // Debits are negative
    payee: toTransferPayee.id,
    notes: destNotes,
    cleared,
    transfer_id: destTxId,
  };
  const destTx: TransactionCreate & { id: string; transfer_id: string } = {
    id: destTxId,
    date,
    amount: Math.abs(amount),
    payee: fromTransferPayee.id,
    notes: destNotes,
    cleared,
    transfer_id: sourceTxId,
  };

  const result = await writer.write(
    `Transfer ${Math.abs(amount)} from ${fromAccountId} to ${toAccountId}`,
    async () => {
      await client.api.addTransactions(fromAccountId, [sourceTx as any]);
      await client.api.addTransactions(toAccountId, [destTx as any]);
      return sourceTxId;
    }
  );

  if (!result.success) throw new Error(result.error);
  return result.data || '';
}
