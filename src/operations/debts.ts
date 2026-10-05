/**
 * Debts — credit cards, loans and EMIs with a monthly due day.
 *
 * A debt is an ordinary Actual account whose note carries a `#debt|` line.
 * The arc app reads the same line to schedule its payment reminders, so all
 * encoding lives in `src/codecs/debt-tag.ts` and is byte-compatible with the
 * app's.
 *
 * Money is integer cents throughout, matching the rest of arc.
 */
import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import {
  daysUntilDue,
  isValidDueDay,
  mergeDebtTag,
  parseDebtTag,
  type DebtTag,
} from '../codecs/debt-tag.js';
import { accountNoteId, mutateNote, readAllNotes } from './notes.js';
import { validateId } from '../utils/validation.js';

export interface Debt extends DebtTag {
  accountId: string;
  accountName: string;
  closed: boolean;
  /** Live account balance in cents. Negative while money is owed. */
  balance: number;
  /** Days until the next due day, counted as the app counts them; null without one. */
  daysUntilDue: number | null;
}

/** Same sum as goals.ts: non-child transactions, so split legs count once. */
async function accountBalance(client: ActualClient, accountId: string): Promise<number> {
  try {
    const txns = await client.api.getTransactions(accountId);
    let balance = 0;
    for (const t of txns) if (!t.is_child) balance += t.amount ?? 0;
    return balance;
  } catch {
    return 0;
  }
}

async function findAccount(client: ActualClient, accountId: string): Promise<any> {
  validateId(accountId);
  const accounts = await client.api.getAccounts();
  const account = (accounts as any[]).find(a => a.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);
  return account;
}

/** Every account carrying a `#debt|` tag, soonest due first. */
export async function listDebts(client: ActualClient, now: Date = new Date()): Promise<Debt[]> {
  client.ensureConnected();
  const [noteRows, accounts] = await Promise.all([
    readAllNotes(client),
    client.api.getAccounts(),
  ]);

  const noteById = new Map(noteRows.map(r => [r.id, r.note]));
  const debts: Debt[] = [];

  for (const account of accounts as any[]) {
    const tag = parseDebtTag(noteById.get(accountNoteId(account.id)) ?? null);
    if (!tag) continue;
    debts.push({
      accountId: account.id,
      accountName: account.name,
      closed: !!account.closed,
      dueDay: tag.dueDay,
      balance: await accountBalance(client, account.id),
      daysUntilDue: tag.dueDay === null ? null : daysUntilDue(tag.dueDay, now),
    });
  }

  debts.sort((a, b) => {
    if (a.daysUntilDue !== b.daysUntilDue) {
      if (a.daysUntilDue === null) return 1;
      if (b.daysUntilDue === null) return -1;
      return a.daysUntilDue - b.daysUntilDue;
    }
    return a.accountName.localeCompare(b.accountName);
  });
  return debts;
}

/**
 * Mark an account as a debt with a monthly due day, or move its due day.
 * Every other line in the account note survives.
 */
export async function setDebt(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string,
  fields: { dueDay: number }
): Promise<Debt> {
  client.ensureConnected();
  if (!isValidDueDay(fields.dueDay)) {
    throw new Error(`Invalid due day: ${fields.dueDay}. Use a day of the month, 1-31.`);
  }
  const account = await findAccount(client, accountId);

  await mutateNote(client, writer, `Set debt due day: ${account.name}`, accountNoteId(account.id), current =>
    mergeDebtTag(current, { dueDay: fields.dueDay })
  );

  const debt = (await listDebts(client)).find(d => d.accountId === account.id);
  if (!debt) throw new Error(`Debt tag did not persist on ${account.name}`);
  return debt;
}

/**
 * Strip the `#debt|` tag from an account. The account, its balance and its
 * transactions are untouched; the app stops reminding about it.
 */
export async function clearDebt(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string
): Promise<{ accountId: string; accountName: string; removed: boolean }> {
  client.ensureConnected();
  const account = await findAccount(client, accountId);

  let removed = false;
  await mutateNote(client, writer, `Clear debt: ${account.name}`, accountNoteId(account.id), current => {
    removed = parseDebtTag(current) !== null;
    // Nothing to remove: leave the note exactly as it is rather than letting
    // mergeDebtTag's trim reshape a note this feature never touched.
    return removed ? mergeDebtTag(current, null) : current ?? '';
  });
  return { accountId: account.id, accountName: account.name, removed };
}
