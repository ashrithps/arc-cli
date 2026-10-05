/**
 * Duplicate detection — ported from the app's `services/duplicateDetectionService.ts`.
 *
 * The app functions read its SQLite mirror through a module-level `database`;
 * here each takes a `LedgerSource` first instead (see `./adapter.ts`).
 * Incoming amounts are MAJOR units, ledger rows minor units, as in the app.
 *
 * Below the port, `findLedgerDuplicates` is CLI-only: the app checks an
 * incoming batch against the ledger, while `arc transactions duplicates`
 * looks for rows that are already in the ledger twice.
 */
import type { DBTransaction, LedgerSource } from './adapter.js';
import {
  findBestReconciliationMatch,
  findStatementReconciliations,
  scoreMerchantMatch,
  type CurrencyRule,
  type StatementReconciliationMatch,
} from './statement.js';

export interface IncomingTransaction {
  account: string;
  amount: number;                          // Amount in display currency (may be foreign)
  type?: 'expense' | 'income' | 'transfer'; // Used to determine sign in DB (expenses are negative)
  date?: string;                           // YYYY-MM-DD
  payee?: string;
  notes?: string;                          // May contain FX info if already converted
  isConverted?: boolean;                   // Flag if currency conversion already applied
  subtransactions?: unknown[];
}

export interface AccountInfo {
  id: string;
  name: string;
}

export interface CurrencyRuleInfo {
  accountId: string;
  rate: number; // Base/Foreign (e.g., 0.012 for INR→USD)
}

export interface DuplicateMatch {
  existingTransaction: DBTransaction;
}

export interface DuplicateAnalysisOptions {
  excludeIndices?: Set<number>;
  dateWindowDays?: number;
  payeeAliases?: Map<string, string[]>;
}

export interface DuplicateAnalysisResult {
  matches: Map<number, DuplicateMatch>;
  reconciliations: Map<number, StatementReconciliationMatch>;
}

// Patterns to extract foreign amount from currency-converted transaction notes.
//
// Format 1 (main app — formatTransactionNote):
//   "₹80.00 INR (FX rate: 0.01109)"  or  "AED 53.26 (FX rate: 0.044)"
//   Captures the last numeric amount before "(FX rate:", skipping any currency code in between.
const APP_FX_PATTERN = /([\d,.]+)[^(]*\(FX [Rr]ate:/;

// Format 2 (iOS Shortcuts — LogTransactionIntent):
//   "[auto-converted: INR 9957.61 → USD 106.72, rate: 0.0107]"
const SHORTCUT_FX_PATTERN = /\[auto-converted:\s*\w+\s+([\d,.]+)\s*→/;

/**
 * Extract the original foreign amount from a transaction's notes.
 * Returns null if the transaction wasn't currency-converted.
 */
function extractForeignAmount(notes: string | null): number | null {
  if (!notes) return null;
  // Try main app format first (most common), then iOS Shortcuts format
  const match = notes.match(APP_FX_PATTERN) || notes.match(SHORTCUT_FX_PATTERN);
  if (!match) return null;
  return parseFloat(match[1].replace(/,/g, ''));
}

/**
 * Transaction dates are calendar days, not timestamps. Keep the source day intact
 * instead of parsing through UTC/local timezone conversion before duplicate matching.
 */
function calendarDay(date: string): string {
  return date.slice(0, 10);
}

/**
 * Check a batch of incoming transactions for duplicates against existing DB transactions.
 * Returns a Map of incoming index → matched existing transaction.
 *
 * Matching logic: strict (same date + same account_id + same amount).
 * For foreign currency accounts, compares the original foreign amount (from notes)
 * rather than the converted base amount, since incoming PDFs use foreign amounts.
 * Excludes transfers, sub-transactions, and tombstoned rows (handled by DB query).
 */
export function checkForDuplicates(
  database: LedgerSource,
  incomingTransactions: IncomingTransaction[],
  accounts: AccountInfo[],
  currencyRules: CurrencyRuleInfo[] = [],
): Map<number, DuplicateMatch> {
  const result = new Map<number, DuplicateMatch>();
  if (incomingTransactions.length === 0) return result;

  const ruleByAccountId = new Map(currencyRules.map(r => [r.accountId, r]));
  const accountNameToId = new Map(accounts.map(a => [a.name, a.id]));

  // Group incoming transactions by account
  const byAccount = new Map<string, Array<{ index: number; date: string; amount: number; type?: string }>>();

  for (let i = 0; i < incomingTransactions.length; i++) {
    const tx = incomingTransactions[i];
    if (!tx.account || !tx.date || tx.amount == null) continue;

    const key = tx.account;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key)!.push({
      index: i,
      date: calendarDay(tx.date),
      amount: Math.abs(tx.amount),
      type: tx.type,
    });
  }

  for (const [accountName, items] of byAccount) {
    const accountId = accountNameToId.get(accountName);
    if (!accountId) continue;

    const hasCurrencyRule = ruleByAccountId.has(accountId);

    // Get all existing transactions for this account in the date range
    const uniqueDates = [...new Set(items.map(item => item.date))];

    if (hasCurrencyRule) {
      // Foreign currency account: query by date only, then compare foreign amounts from notes
      for (const item of items) {
        // Query existing transactions for this date + account (any amount)
        // findPotentialDuplicates requires amounts — use a broader query instead
        const allForDate = database.findTransactionsByAccountAndDate(accountId, item.date);

        for (const e of allForDate) {
          const foreignAmount = extractForeignAmount(e.notes);
          if (foreignAmount === null) continue;

          // Compare the foreign amount with the incoming amount
          if (
            calendarDay(e.date) === item.date
            && Math.abs(foreignAmount - item.amount) < 0.01
          ) {
            result.set(item.index, { existingTransaction: e });
            break;
          }
        }
      }
    } else {
      // Base currency account: compare amounts directly in cents
      const amountsWithSign = items.map(item => {
        const absCents = Math.round(item.amount * 100);
        return item.type === 'expense' ? -absCents : absCents;
      });
      const uniqueAmounts = [...new Set(amountsWithSign)];

      const existing = database.findPotentialDuplicates(accountId, uniqueDates, uniqueAmounts);
      if (existing.length === 0) continue;

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const amountCents = amountsWithSign[idx];
        const match = existing.find(
          e => e.date === item.date && e.amount === amountCents && e.account_id === accountId
        );
        if (match) {
          result.set(item.index, { existingTransaction: match });
        }
      }
    }
  }

  return result;
}

/**
 * Runs duplicate analysis for review imports. Exact duplicates still come from
 * checkForDuplicates; near-miss FX estimates then use the statement reconciliation matcher,
 * which compares merchant names case-insensitively and allows safe prefix/substring matches.
 */
export function analyzeDuplicateCandidates(
  database: LedgerSource,
  incomingTransactions: IncomingTransaction[],
  accounts: AccountInfo[],
  currencyRules: Array<CurrencyRuleInfo & Partial<CurrencyRule>> = [],
  options: DuplicateAnalysisOptions = {},
): DuplicateAnalysisResult {
  const exactMatches = checkForDuplicates(database, incomingTransactions, accounts, currencyRules);
  const excludeIndices = new Set<number>([
    ...exactMatches.keys(),
    ...(options.excludeIndices ?? []),
  ]);

  const reconciliations = findStatementReconciliations(
    database,
    incomingTransactions,
    accounts,
    currencyRules as CurrencyRule[],
    {
      excludeIndices,
      dateWindowDays: options.dateWindowDays,
      payeeAliases: options.payeeAliases,
    },
  );

  return { matches: exactMatches, reconciliations };
}

/**
 * Find potential duplicates for a single existing transaction (for EditTransactionModal).
 * Looks up the transaction from DB by ID, then finds matches excluding itself.
 */
export function findMatchesForTransaction(database: LedgerSource, transactionId: string): DBTransaction[] {
  const tx = database.getTransactionById(transactionId);
  if (!tx) return [];

  // Don't check transfers
  if (tx.transfer_id) return [];

  const matches = database.findPotentialDuplicates(
    tx.account_id,
    [tx.date],
    [tx.amount],
  );

  // Exclude self
  return matches.filter(m => m.id !== transactionId);
}

// ── CLI: duplicates already inside the ledger ──────────────────────────────

export interface LedgerDuplicateOptions {
  /** How far apart two rows may be dated and still pair. Default 2, the app's window. */
  dateWindowDays?: number;
  /** Groups scoring below this are dropped. Default 60. */
  minScore?: number;
  currencyRules?: CurrencyRule[];
}

export interface LedgerDuplicateGroup {
  accountId: string;
  /** 0–100; the strongest pair in the group. */
  score: number;
  reasons: string[];
  transactions: DBTransaction[];
}

// CLI-generated ids (`makeImportedId`) hash the row's content, so two of them
// differing says nothing. Anything else came from a bank feed, where two
// different ids are two different bank transactions.
const isBankImportedId = (id: string | null | undefined): id is string =>
  Boolean(id) && !id!.startsWith('arctual:');

function calendarDistance(a: string, b: string): number {
  const ms = Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(Math.abs(ms) / 86400000) : Number.MAX_SAFE_INTEGER;
}

function scorePair(
  a: DBTransaction,
  b: DBTransaction,
  windowDays: number,
  currencyRules: CurrencyRule[],
): { score: number; reasons: string[] } | null {
  if ((a.amount >= 0) !== (b.amount >= 0)) return null;
  const distance = calendarDistance(a.date, b.date);
  if (distance > windowDays) return null;

  const merchant = scoreMerchantMatch(a.payee_name, b.payee_name);
  let score: number;
  let reasons: string[];

  if (a.amount === b.amount) {
    if (distance === 0) {
      // The app's exact rule (same account, date and amount) flags these
      // whatever the payee says; the payee only moves the score.
      score = 60 + 40 * merchant;
      reasons = ['same date', 'same amount', `merchant ${Math.round(merchant * 100)}%`];
    } else {
      // A pending row and its settled twin usually land a day or two apart.
      if (merchant < 0.58) return null;
      score = 40 + 40 * merchant - 5 * distance;
      reasons = [`${distance}d apart`, 'same amount', `merchant ${Math.round(merchant * 100)}%`];
    }
  } else {
    // Different amounts: only the FX-drift case the statement matcher already
    // understands (an estimate logged first, the bank's posting later).
    const match = findBestReconciliationMatch(
      {
        account: a.account_id,
        type: a.amount < 0 ? 'expense' : 'income',
        amount: Math.abs(a.amount) / 100,
        payee: a.payee_name ?? undefined,
        notes: a.notes ?? undefined,
        date: a.date,
      },
      [b],
      { id: a.account_id, name: a.account_id },
      currencyRules,
      undefined,
      windowDays,
    );
    if (!match) return null;
    score = match.score * 0.8;
    reasons = [...match.reasons.filter(r => r !== 'same account'), 'amounts differ'];
  }

  if (isBankImportedId(a.imported_id) && isBankImportedId(b.imported_id) && a.imported_id !== b.imported_id) {
    score -= 45;
    reasons.push('both bank-imported with different ids');
  }

  return { score: Math.round(Math.max(0, Math.min(100, score))), reasons };
}

/**
 * Rows that look like the same real-world transaction recorded twice.
 *
 * Skips transfers (a transfer pair is two rows by design), split children
 * (legs of one purchase share a date), split parents (they would pair with
 * their own children's totals) and starting balances. Pairs are joined into
 * groups, so three copies of one coffee come back as one group.
 */
export function findLedgerDuplicates(
  rows: DBTransaction[],
  options: LedgerDuplicateOptions = {},
): LedgerDuplicateGroup[] {
  const windowDays = options.dateWindowDays ?? 2;
  const minScore = options.minScore ?? 60;
  const currencyRules = options.currencyRules ?? [];

  const eligible = rows.filter(t =>
    !t.tombstone && !t.transfer_id && !t.is_child && !t.is_parent && !t.starting_balance_flag && t.amount !== 0
  );

  const byAccount = new Map<string, DBTransaction[]>();
  for (const t of eligible) {
    if (!byAccount.has(t.account_id)) byAccount.set(t.account_id, []);
    byAccount.get(t.account_id)!.push(t);
  }

  const groups: LedgerDuplicateGroup[] = [];
  for (const [accountId, list] of byAccount) {
    list.sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id));

    // Anchor clustering, not union-find: every member must pair with the
    // group's first row inside the window. Transitive merging chained a daily
    // $1 fee across a whole week into one "duplicate" group.
    const taken = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      if (taken.has(i)) continue;
      const members = [i];
      let top: { score: number; reasons: string[] } | null = null;
      for (let j = i + 1; j < list.length; j++) {
        if (calendarDistance(list[i].date, list[j].date) > windowDays) break;
        if (taken.has(j)) continue;
        const pair = scorePair(list[i], list[j], windowDays, currencyRules);
        if (!pair || pair.score < minScore) continue;
        members.push(j);
        if (!top || pair.score > top.score) top = pair;
      }
      if (members.length < 2 || !top) continue;

      // A charge that recurs on consecutive days (a daily fee, a commute fare)
      // is a series, not a duplicate. Keep only rows that share a date.
      const txs = members.map(k => list[k]);
      const dates = new Set(txs.map(t => t.date));
      const isSeries = dates.size >= 3 || (dates.size === 2 && seriesContinues(list, list[i], windowDays, currencyRules, minScore));
      const kept = isSeries ? sameDateRows(members, list) : members;
      if (kept.length < 2) continue;
      for (const k of kept) taken.add(k);
      const anchor = list[kept[0]];
      const best = kept.slice(1)
        .map(k => scorePair(anchor, list[k], windowDays, currencyRules))
        .filter((p): p is { score: number; reasons: string[] } => Boolean(p))
        .sort((p, q) => q.score - p.score)[0] ?? top;
      groups.push({ accountId, score: best.score, reasons: best.reasons, transactions: kept.map(k => list[k]) });
    }
  }

  return groups.sort((a, b) => b.score - a.score || a.transactions[0].date.localeCompare(b.transactions[0].date));
}

/** Indices (from `members`) of rows that share their date with another member, earliest date first. */
function sameDateRows(members: number[], list: DBTransaction[]): number[] {
  const byDate = new Map<string, number[]>();
  for (const k of members) {
    const d = list[k].date;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(k);
  }
  const first = [...byDate.values()].find(ks => ks.length >= 2);
  return first ?? [];
}

/**
 * Whether `anchor`'s charge also appears just before it or two-plus days after,
 * i.e. the pair is part of a longer run rather than one double entry.
 */
function seriesContinues(
  list: DBTransaction[],
  anchor: DBTransaction,
  windowDays: number,
  currencyRules: CurrencyRule[],
  minScore: number,
): boolean {
  const dates = new Set<string>();
  for (const t of list) {
    if (t.id === anchor.id) continue;
    const d = calendarDistance(anchor.date, t.date);
    if (d === 0 || d > windowDays + 2) continue;
    const pair = scorePair(anchor, t, windowDays + 2, currencyRules);
    if (pair && pair.score >= minScore) dates.add(t.date);
  }
  return dates.size >= 2;
}
