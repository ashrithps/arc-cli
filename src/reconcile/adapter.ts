/**
 * The bridge between `@actual-app/api` rows and the app's row shape.
 *
 * The reconciliation and duplicate modules are ported from the app, which
 * reads its own SQLite mirror: rows carry `account_id`, `payee_name` and
 * `category_id`, and the lookups are synchronous SQL. The API instead
 * returns `TransactionEntity` rows — `account`, `payee` (an id, not a name),
 * `category` — grouped so split children live under their parent's
 * `subtransactions`.
 *
 * Two things live here so the ported modules stay pure:
 *   - `toDbTransaction` / `flattenLedger`: entity → app row, with payee names
 *     resolved from `api.getPayees()`.
 *   - `inMemoryLedger`: the handful of `Database` queries the app modules
 *     call, answered from rows the operation layer already fetched. Each one
 *     mirrors the WHERE clause of the SQL it replaces, including the odd
 *     ones (`findPotentialDuplicates` keeps split children; the range query
 *     drops them).
 */

/** The app's `services/db/types.ts` `Transaction`, reduced to what the ports read. */
export interface DBTransaction {
  id: string;
  account_id: string;
  account_name: string | null;
  category_id: string | null;
  category_name: string | null;
  /** Signed minor units. */
  amount: number;
  /** Payee id. */
  payee: string | null;
  payee_name: string | null;
  notes: string | null;
  date: string;
  cleared: boolean;
  reconciled?: number | boolean | null;
  synced_at: string;
  transfer_id?: string | null;
  schedule?: string | null;
  imported_id?: string | null;
  imported_payee?: string | null;
  is_parent?: number | boolean | null;
  is_child?: number | boolean | null;
  parent_id?: string | null;
  tombstone?: number | boolean | null;
  starting_balance_flag?: boolean | null;
}

/** The subset of an API `TransactionEntity` the adapter reads. */
export interface ApiTransactionLike {
  id: string;
  account: string;
  date: string;
  amount?: number | null;
  payee?: string | null;
  category?: string | null;
  notes?: string | null;
  cleared?: boolean | null;
  reconciled?: boolean | null;
  transfer_id?: string | null;
  schedule?: string | null;
  imported_id?: string | null;
  imported_payee?: string | null;
  is_parent?: boolean | null;
  is_child?: boolean | null;
  parent_id?: string | null;
  tombstone?: boolean | null;
  starting_balance_flag?: boolean | null;
  subtransactions?: ApiTransactionLike[] | null;
}

export interface AdapterContext {
  /** payee id → display name. */
  payeeNames?: Map<string, string>;
  /** account id → display name. */
  accountNames?: Map<string, string>;
  /** category id → display name. */
  categoryNames?: Map<string, string>;
}

/** Build an id → name map from `api.getPayees()` (or accounts / categories). */
export function nameMap(rows: Array<{ id: string; name?: string | null }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r?.id && r.name) out.set(r.id, r.name);
  }
  return out;
}

/**
 * One API row → one app row. The payee name falls back to `imported_payee`
 * when the payee id does not resolve: a bank-imported row whose payee was
 * later deleted still has the descriptor the bank sent, and that is what a
 * statement line will be matched against.
 */
export function toDbTransaction(t: ApiTransactionLike, ctx: AdapterContext = {}): DBTransaction {
  const payeeName = (t.payee && ctx.payeeNames?.get(t.payee)) || t.imported_payee || null;
  return {
    id: t.id,
    account_id: t.account,
    account_name: ctx.accountNames?.get(t.account) ?? null,
    category_id: t.category ?? null,
    category_name: (t.category && ctx.categoryNames?.get(t.category)) || null,
    amount: t.amount ?? 0,
    payee: t.payee ?? null,
    payee_name: payeeName,
    notes: t.notes ?? null,
    date: t.date,
    cleared: Boolean(t.cleared),
    reconciled: t.reconciled ?? null,
    synced_at: '',
    transfer_id: t.transfer_id ?? null,
    schedule: t.schedule ?? null,
    imported_id: t.imported_id ?? null,
    imported_payee: t.imported_payee ?? null,
    is_parent: t.is_parent ?? null,
    is_child: t.is_child ?? null,
    parent_id: t.parent_id ?? null,
    tombstone: t.tombstone ?? null,
    starting_balance_flag: t.starting_balance_flag ?? null,
  };
}

/**
 * `getTransactions` returns splits grouped; the app's table is flat. Children
 * come out as their own rows flagged `is_child`, each carrying the parent's
 * account and date when the API left them off.
 */
export function flattenLedger(rows: ApiTransactionLike[], ctx: AdapterContext = {}): DBTransaction[] {
  const out: DBTransaction[] = [];
  for (const t of rows) {
    out.push(toDbTransaction(t, ctx));
    for (const child of t.subtransactions ?? []) {
      out.push(toDbTransaction({
        ...child,
        account: child.account ?? t.account,
        date: child.date ?? t.date,
        is_child: true,
        parent_id: child.parent_id ?? t.id,
      }, ctx));
    }
  }
  return out;
}

/** The `Database` methods the ported modules call, injected instead of `require('./Database')`. */
export interface LedgerSource {
  findTransactionsByAccountAndDate(accountId: string, date: string): DBTransaction[];
  findTransactionsByAccountAndDateRange(accountId: string, startDate: string, endDate: string): DBTransaction[];
  findPotentialDuplicates(accountId: string, dates: string[], amounts: number[]): DBTransaction[];
  getTransactionById(id: string): DBTransaction | null;
  getAccountBalanceAsOf(accountId: string, date: string, inclusive?: boolean): number;
}

const live = (t: DBTransaction) => !t.tombstone;

/** A `LedgerSource` over rows already in memory. */
export function inMemoryLedger(rows: DBTransaction[]): LedgerSource {
  return {
    findTransactionsByAccountAndDate(accountId, date) {
      return rows.filter(t => live(t) && !t.is_child && t.account_id === accountId && t.date === date);
    },
    findTransactionsByAccountAndDateRange(accountId, startDate, endDate) {
      return rows.filter(t =>
        live(t) && !t.is_child && t.account_id === accountId && t.date >= startDate && t.date <= endDate
      );
    },
    findPotentialDuplicates(accountId, dates, amounts) {
      if (dates.length === 0 || amounts.length === 0) return [];
      const dateSet = new Set(dates);
      const amountSet = new Set(amounts);
      return rows.filter(t =>
        live(t) && !t.is_parent && t.account_id === accountId && dateSet.has(t.date) && amountSet.has(t.amount)
      );
    },
    getTransactionById(id) {
      return rows.find(t => t.id === id) ?? null;
    },
    getAccountBalanceAsOf(accountId, date, inclusive = true) {
      let sum = 0;
      for (const t of rows) {
        if (!live(t) || t.is_parent || t.account_id !== accountId) continue;
        if (inclusive ? t.date <= date : t.date < date) sum += t.amount;
      }
      return sum;
    },
  };
}
