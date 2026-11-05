/**
 * Group splits — sharing a transaction with other people.
 *
 * A split is a virtual overlay written into the transaction's note as
 * `#gsplit|` tokens (see src/codecs/split-token.ts). It never moves money:
 * balances, registers and reconciliation are untouched. What it records is
 * how much of a transaction someone else owes you — a receivable.
 *
 * All amounts are integer minor units.
 */
import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import type { Transaction } from '../types.js';
import {
  IOU_ACCOUNT_TAG,
  iouEntries,
  lessCarried,
  parseIouCarries,
  parseIouGroups,
  personBalances,
  shareStatuses,
  stripIouMarkers,
  type IouRow,
} from '../codecs/iou-ledger.js';
import { readAllNotes } from './notes.js';
import {
  generateGid,
  isRefundedNote,
  owedPortionForTransaction,
  parseSplitTokens,
  personKey,
  removeSplitGroup,
  removeSplitToken,
  stripSplitTokensForDisplay,
  upsertSplitToken,
  type SplitToken,
} from '../codecs/split-token.js';

export interface SplitTransaction extends SplitToken {
  transactionId: string;
  date: string;
  /** Full transaction amount in minor units (signed). */
  transactionAmount: number;
  payeeName?: string;
  accountId: string;
  accountName: string;
  /** The note with split tokens stripped out. */
  note: string | null;
}

export interface SplitGroup {
  gid: string;
  date: string;
  payeeName?: string;
  accountName: string;
  transactionId: string;
  transactionAmount: number;
  /** Total others owe on this split, minor units. */
  owedTotal: number;
  people: Array<{
    person: string;
    share: number;
    amt: number;
    status: 'open' | 'paid';
    settled?: string;
    stxid?: string;
  }>;
}

export interface PersonBalance {
  person: string;
  /** Still owed, minor units. */
  open: number;
  /** Already settled, minor units. */
  paid: number;
  splitCount: number;
}

function yyyymmdd(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Every transaction carrying split tokens, across all accounts.
 *
 * The app reads this from its SQLite mirror with a `notes LIKE '%#gsplit|%'`
 * scan; here it is the same scan over the AQL ledger, account by account.
 */
export async function listSplitTransactions(
  client: ActualClient,
  options: { start?: string; end?: string } = {}
): Promise<SplitTransaction[]> {
  client.ensureConnected();
  const accounts = await client.api.getAccounts();
  const out: SplitTransaction[] = [];

  for (const account of accounts as any[]) {
    const txns = await client.api.getTransactions(account.id, options.start, options.end);
    for (const t of txns as any[]) {
      // Refunded: nobody owes a share of it (app 1.0.49, SplitTagService).
      if (isRefundedNote(t.notes)) continue;
      const tokens = parseSplitTokens(t.notes);
      if (tokens.length === 0) continue;
      for (const token of tokens) {
        out.push({
          ...token,
          transactionId: t.id,
          date: t.date,
          transactionAmount: t.amount ?? 0,
          payeeName: t.payee_name ?? undefined,
          accountId: account.id,
          accountName: account.name,
          note: stripSplitTokensForDisplay(t.notes),
        });
      }
    }
  }

  out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return out;
}

/** Split events, grouped by `gid`. */
export async function listSplitGroups(
  client: ActualClient,
  options: { start?: string; end?: string; person?: string; openOnly?: boolean } = {}
): Promise<SplitGroup[]> {
  const rows = await listSplitTransactions(client, options);
  const byGid = new Map<string, SplitGroup>();

  for (const row of rows) {
    let group = byGid.get(row.gid);
    if (!group) {
      group = {
        gid: row.gid,
        date: row.date,
        payeeName: row.payeeName,
        accountName: row.accountName,
        transactionId: row.transactionId,
        transactionAmount: row.transactionAmount,
        owedTotal: 0,
        people: [],
      };
      byGid.set(row.gid, group);
    }
    group.people.push({
      person: row.person,
      share: row.share,
      amt: row.amt,
      status: row.status,
      settled: row.settled,
      stxid: row.stxid,
    });
    if (row.status === 'open') group.owedTotal += row.amt;
  }

  let groups = Array.from(byGid.values());
  if (options.person) {
    const needle = personKey(options.person);
    groups = groups.filter(g => g.people.some(p => personKey(p.person) === needle));
  }
  if (options.openOnly) groups = groups.filter(g => g.owedTotal > 0);
  return groups;
}

/** What each person still owes you, and what they have already settled. */
export async function getReceivables(
  client: ActualClient,
  options: { start?: string; end?: string } = {}
): Promise<PersonBalance[]> {
  const rows = await listSplitTransactions(client, options);
  const byPerson = new Map<string, PersonBalance>();

  for (const row of rows) {
    const key = personKey(row.person);
    let entry = byPerson.get(key);
    if (!entry) {
      entry = { person: row.person, open: 0, paid: 0, splitCount: 0 };
      byPerson.set(key, entry);
    }
    entry.splitCount += 1;
    if (row.status === 'paid') entry.paid += row.amt;
    else entry.open += row.amt;
  }

  return Array.from(byPerson.values()).sort((a, b) => b.open - a.open);
}

async function findTransaction(
  client: ActualClient,
  transactionId: string
): Promise<{ tx: any; accountId: string }> {
  const accounts = await client.api.getAccounts();
  for (const account of accounts as any[]) {
    const txns = await client.api.getTransactions(account.id);
    const tx = (txns as any[]).find(t => t.id === transactionId);
    if (tx) return { tx, accountId: account.id };
  }
  throw new Error(`Transaction not found: ${transactionId}`);
}

/** Rewrite one transaction's note through a token-preserving transform. */
async function mutateTransactionNote(
  client: ActualClient,
  writer: SafeWriter,
  transactionId: string,
  label: string,
  fn: (notes: string) => string
): Promise<string> {
  client.ensureConnected();
  let next = '';
  const result = await writer.write(label, async () => {
    // Re-read inside the write, after SafeWriter's sync, so a concurrent edit
    // from the phone is merged rather than clobbered.
    const { tx } = await findTransaction(client, transactionId);
    next = fn(tx.notes ?? '');
    return client.api.updateTransaction(transactionId, { notes: next } as any);
  });
  if (!result.success) throw new Error(result.error);
  return next;
}

export type SplitMode = 'equal' | 'percent' | 'exact' | 'shares';

export interface CreateSplitParams {
  transactionId: string;
  people: string[];
  mode: SplitMode;
  /**
   * Per-person values, positional against `people`:
   *   percent -> 0-100 each
   *   exact   -> minor units each
   *   shares  -> relative weights
   * Ignored for `equal`.
   */
  values?: number[];
  /** Whether you are also one of the people sharing the cost. */
  includeSelf?: boolean;
}

/**
 * Share a transaction with one or more people.
 *
 * `equal` splits the transaction n+1 ways when you are included, n ways when
 * you are not — the difference between "four of us split dinner" and "I paid,
 * these three owe me their quarters".
 */
export async function createSplit(
  client: ActualClient,
  writer: SafeWriter,
  params: CreateSplitParams
): Promise<SplitGroup> {
  if (params.people.length === 0) throw new Error('A split needs at least one person.');

  const { tx } = await findTransaction(client, params.transactionId);
  const total = Math.abs(tx.amount ?? 0);
  if (total === 0) throw new Error('Cannot split a zero-amount transaction.');

  const existing = parseSplitTokens(tx.notes);
  if (existing.length > 0) {
    throw new Error(
      `Transaction ${params.transactionId} is already split (group ${existing[0].gid}). ` +
      `Remove it first with \`arc splits delete\`, or add a person with \`arc splits add\`.`
    );
  }

  const shares = computeShares(params, total);
  const gid = generateGid();
  const created = yyyymmdd();

  await mutateTransactionNote(
    client,
    writer,
    params.transactionId,
    `Split transaction ${params.transactionId} with ${params.people.join(', ')}`,
    notes => {
      let next = notes;
      for (const { person, share, amt } of shares) {
        next = upsertSplitToken(next, {
          gid,
          person,
          share,
          amt,
          status: 'open',
          created,
        });
      }
      return next;
    }
  );

  const groups = await listSplitGroups(client);
  const group = groups.find(g => g.gid === gid);
  if (!group) throw new Error('Split was written but could not be read back.');
  return group;
}

/**
 * Turn a mode + values into per-person shares.
 *
 * Rounding is settled by giving the remainder to the last person, so the
 * per-person amounts always sum to exactly what was intended. Percent and
 * exact splits are validated rather than silently under-billing.
 */
export function computeShares(
  params: CreateSplitParams,
  totalMinor: number
): Array<{ person: string; share: number; amt: number }> {
  const { people, mode, values, includeSelf } = params;
  const n = people.length;

  let weights: number[];
  switch (mode) {
    case 'equal': {
      const parts = includeSelf ? n + 1 : n;
      weights = new Array(n).fill(1 / parts);
      break;
    }
    case 'percent': {
      if (!values || values.length !== n) {
        throw new Error(`percent split needs one value per person (${n} expected).`);
      }
      const sum = values.reduce((a, b) => a + b, 0);
      if (sum > 100.0001) {
        throw new Error(`percent split totals ${sum}%, which is more than 100%.`);
      }
      weights = values.map(v => v / 100);
      break;
    }
    case 'exact': {
      if (!values || values.length !== n) {
        throw new Error(`exact split needs one amount per person (${n} expected).`);
      }
      const sum = values.reduce((a, b) => a + b, 0);
      if (sum > totalMinor) {
        throw new Error(
          `exact split totals ${sum} minor units, more than the transaction's ${totalMinor}.`
        );
      }
      return people.map((person, i) => ({
        person,
        share: totalMinor > 0 ? values[i] / totalMinor : 0,
        amt: Math.round(values[i]),
      }));
    }
    case 'shares': {
      if (!values || values.length !== n) {
        throw new Error(`shares split needs one weight per person (${n} expected).`);
      }
      const totalShares = values.reduce((a, b) => a + b, 0) + (includeSelf ? 1 : 0);
      if (totalShares <= 0) throw new Error('shares split needs a positive total weight.');
      weights = values.map(v => v / totalShares);
      break;
    }
    default:
      throw new Error(`Unknown split mode: ${mode}. Use equal, percent, exact, or shares.`);
  }

  const amounts = weights.map(w => Math.round(totalMinor * w));
  // Push any rounding drift onto the last person so the parts sum exactly.
  const drift = amounts.reduce((a, b) => a + b, 0) - Math.round(totalMinor * weights.reduce((a, b) => a + b, 0));
  if (drift !== 0 && amounts.length > 0) amounts[amounts.length - 1] -= drift;

  return people.map((person, i) => ({ person, share: weights[i], amt: amounts[i] }));
}

async function setStatus(
  client: ActualClient,
  writer: SafeWriter,
  gid: string,
  person: string,
  status: 'open' | 'paid',
  settlingTxId?: string
): Promise<SplitGroup> {
  const rows = await listSplitTransactions(client);
  const needle = personKey(person);
  const row = rows.find(r => r.gid === gid && personKey(r.person) === needle);
  if (!row) throw new Error(`No split found for ${person} in group ${gid}.`);

  await mutateTransactionNote(
    client,
    writer,
    row.transactionId,
    `${status === 'paid' ? 'Settle' : 'Reopen'} split ${gid} for ${row.person}`,
    notes => {
      const token: SplitToken = {
        gid,
        person: row.person,
        share: row.share,
        amt: row.amt,
        status,
        created: row.created,
      };
      if (status === 'paid') {
        token.settled = yyyymmdd();
        if (settlingTxId) token.stxid = settlingTxId;
      }
      return upsertSplitToken(notes, token);
    }
  );

  const group = (await listSplitGroups(client)).find(g => g.gid === gid);
  if (!group) throw new Error('Split was updated but could not be read back.');
  return group;
}

export function settleSplit(
  client: ActualClient,
  writer: SafeWriter,
  gid: string,
  person: string,
  settlingTxId?: string
) {
  return setStatus(client, writer, gid, person, 'paid', settlingTxId);
}

export function reopenSplit(
  client: ActualClient,
  writer: SafeWriter,
  gid: string,
  person: string
) {
  return setStatus(client, writer, gid, person, 'open');
}

/** Drop one person from a split, leaving the others intact. */
export async function removePerson(
  client: ActualClient,
  writer: SafeWriter,
  gid: string,
  person: string
): Promise<{ gid: string; person: string }> {
  const rows = await listSplitTransactions(client);
  const needle = personKey(person);
  const row = rows.find(r => r.gid === gid && personKey(r.person) === needle);
  if (!row) throw new Error(`No split found for ${person} in group ${gid}.`);

  await mutateTransactionNote(
    client,
    writer,
    row.transactionId,
    `Remove ${row.person} from split ${gid}`,
    notes => removeSplitToken(notes, gid, row.person)
  );
  return { gid, person: row.person };
}

/** Delete an entire split group across every transaction carrying it. */
export async function deleteSplit(
  client: ActualClient,
  writer: SafeWriter,
  gid: string
): Promise<{ gid: string; transactions: number }> {
  const rows = await listSplitTransactions(client);
  const txIds = Array.from(new Set(rows.filter(r => r.gid === gid).map(r => r.transactionId)));
  if (txIds.length === 0) throw new Error(`Split group not found: ${gid}`);

  for (const txId of txIds) {
    await mutateTransactionNote(
      client,
      writer,
      txId,
      `Delete split ${gid}`,
      notes => removeSplitGroup(notes, gid)
    );
  }
  return { gid, transactions: txIds.length };
}

/**
 * How much of each transaction is owed by other people.
 *
 * Spending reports that ignore this overstate what the user actually spent on
 * any split transaction — which is why the app subtracts it.
 */
export async function getOwedAdjustments(
  client: ActualClient
): Promise<Record<string, number>> {
  const accounts = await client.api.getAccounts();
  const map: Record<string, number> = {};
  for (const account of accounts as any[]) {
    const txns = await client.api.getTransactions(account.id);
    for (const t of txns as any[]) {
      const owed = owedPortionForTransaction(t.notes);
      if (owed > 0) map[t.id] = owed;
    }
  }
  return map;
}

// ── The IOUs ledger (app 1.0.49 Splits) ─────────────────────────────────────

export interface IouPerson {
  person: string;
  /** Positive: they owe you. Negative: you owe them. Minor units. */
  balance: number;
  lastDate: string;
  /** Shares and debts not yet settled, oldest first (payments go to the oldest). */
  open: Array<{ id: string; date: string; kind: string; amount: number; left: number; status: string; label: string; category: string | null }>;
  /** Every row with them, newest first (only with `history`). */
  entries?: Array<{ id: string; date: string; kind: string; amount: number; label: string; category: string | null }>;
}

/**
 * Who owes whom in the IOUs ledger the arc app (1.0.49+) keeps in the budget:
 * one on-budget account (note tag `#iou:v1`) whose rows are what people owe
 * you (positive) and what you owe them (negative). Balances leave out rows a
 * shared arc split wrote (they settle in Splits) and balances carried into a
 * Splits thread, exactly as the app's IOUs screen does. Read-only: shared
 * Splits threads themselves are sealed on arc's servers and not reachable here.
 */
export async function listIouBalances(
  client: ActualClient,
  options: { person?: string; history?: boolean } = {}
): Promise<{
  account: { id: string; name: string } | null;
  owedToYou: number;
  youOwe: number;
  people: IouPerson[];
  groups: Array<{ id: string; name: string; people: string[] }>;
}> {
  client.ensureConnected();
  const [accounts, notes, payees, groups] = await Promise.all([
    client.api.getAccounts() as Promise<any[]>,
    readAllNotes(client),
    client.api.getPayees() as Promise<any[]>,
    client.api.getCategoryGroups() as Promise<any[]>,
  ]);
  const open = new Map(accounts.filter((a) => !a.closed).map((a) => [a.id, a]));
  const tagged = notes.find((n) => n.id.startsWith('account-') && n.note.includes(IOU_ACCOUNT_TAG) && open.has(n.id.slice(8)));
  const account = tagged ? open.get(tagged.id.slice(8)) : undefined;
  if (!account) return { account: null, owedToYou: 0, youOwe: 0, people: [], groups: [] };
  const accountNote = tagged!.note;

  const payeeName = new Map(payees.map((p: any) => [p.id, p.name ?? null]));
  const categoryName = new Map<string, string>();
  for (const g of groups ?? []) for (const c of g.categories ?? []) categoryName.set(c.id, c.name);
  const res: any = await client.api.aqlQuery(
    client.api
      .q('transactions')
      .filter({ account: account.id })
      .options({ splits: 'inline' })
      .select(['id', 'date', 'amount', 'notes', 'payee', 'category'])
  );
  const rows: IouRow[] = (res?.data ?? []).map((t: any) => ({
    id: t.id,
    date: t.date,
    amount: t.amount ?? 0,
    payee: t.payee ? payeeName.get(t.payee) ?? null : null,
    notes: t.notes ?? null,
    categoryId: t.category ?? null,
    categoryName: t.category ? categoryName.get(t.category) ?? null : null,
  }));
  const entries = iouEntries(rows);
  const balances = lessCarried(personBalances(entries.filter((e) => !e.marker?.gid?.startsWith('s:'))), parseIouCarries(accountNote));
  const wanted = options.person ? personKey(options.person) : null;
  const people: IouPerson[] = balances
    .filter((b) => !wanted || personKey(b.person) === wanted)
    .map((b) => {
      const statuses = shareStatuses(b.entries);
      const oldestFirst = [...b.entries].reverse();
      return {
        person: b.person,
        balance: b.balance,
        lastDate: b.lastDate,
        open: oldestFirst
          .filter((e) => statuses.get(e.id) && statuses.get(e.id)!.status !== 'settled')
          .map((e) => ({
            id: e.id,
            date: e.date,
            kind: e.kind,
            amount: e.amount,
            left: statuses.get(e.id)!.left,
            status: statuses.get(e.id)!.status,
            label: stripIouMarkers(e.notes),
            category: e.categoryName ?? null,
          })),
        ...(options.history
          ? { entries: b.entries.map((e) => ({ id: e.id, date: e.date, kind: e.kind, amount: e.amount, label: stripIouMarkers(e.notes), category: e.categoryName ?? null })) }
          : {}),
      };
    });
  if (wanted && people.length === 0) throw new Error(`No one called ${options.person} in the IOUs ledger.`);
  return {
    account: { id: account.id, name: account.name },
    owedToYou: people.reduce((s, p) => s + Math.max(0, p.balance), 0),
    youOwe: people.reduce((s, p) => s + Math.max(0, -p.balance), 0),
    people,
    groups: parseIouGroups(accountNote),
  };
}
