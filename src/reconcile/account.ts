/**
 * Account reconciliation — matching an account against what the bank says.
 *
 * Ported from the app's `services/accountReconciliation.ts`, which mirrors
 * Actual desktop: compare the bank balance against the account's *cleared*
 * balance, and once they agree lock every cleared row as reconciled and stamp
 * `accounts.last_reconciled`.
 *
 * Not to be confused with `./statement.ts`, which fuzzy-matches statement
 * lines against existing transactions. That one answers "is this row already
 * in my budget?"; this one answers "does my budget agree with my bank?".
 *
 * One deliberate change from the app: `buildReconcileAdjustment` returns
 * minor units. The app's version returned dollars because that is what its
 * `createTransaction` takes; the CLI is cents everywhere below the registry.
 */

/** Payee Actual itself uses, so a desktop user recognises the row. */
export const RECONCILE_ADJUSTMENT_PAYEE = 'Reconciliation Balance Adjustment';

// Amounts beyond this lose cent precision once multiplied by 100.
const MAX_SAFE_NUMBER = 2 ** 51 - 1;
const MIN_SAFE_NUMBER = -MAX_SAFE_NUMBER;

/**
 * Permissive parser for amounts from sources whose locale may not match the
 * user's (the app's `utils/amount.ts::looselyParseAmount`). Ignores currency
 * symbols and separators and decides the decimal mark by position: a `.` or
 * `,` followed by 1–2 or 4–9 characters is decimal, 3 is a thousands
 * separator. `(50.00)` reads as negative, the way statements print debits.
 * Returns major units, or null.
 */
export function looselyParseAmount(amount: string): number | null {
  function clamp(v: number): number | null {
    if (isNaN(v)) return null;
    const value = v * 100;
    if (value > MAX_SAFE_NUMBER || value < MIN_SAFE_NUMBER) return null;
    return v;
  }

  function digits(v: string): string {
    return v.replace(/[^0-9-]/g, '');
  }

  if (amount.startsWith('(') && amount.endsWith(')')) {
    amount = amount.replace(/−/g, '');
    amount = amount.replace('(', '-').replace(')', '');
  } else {
    amount = amount.replace(/−/g, '-');
  }

  const m = amount.match(/[.,]([^.,]{4,9}|[^.,]{1,2})$/);
  if (!m || m.index === undefined) {
    return clamp(parseFloat(digits(amount)));
  }

  const left = digits(amount.slice(0, m.index));
  const right = digits(amount.slice(m.index + 1));
  return clamp(parseFloat(left + '.' + right));
}

export interface ReconcileComparison {
  /** Settled balance in cents. */
  clearedBalance: number;
  /** What the bank says, in cents. `null` while unparseable or empty. */
  targetBalance: number | null;
  /**
   * target − cleared, in cents. Positive means the bank holds more than arc
   * knows about (a missing deposit); negative means arc is over-counting.
   * `null` whenever `targetBalance` is.
   */
  difference: number | null;
  /** True only once a real number has been entered and it matches exactly. */
  isBalanced: boolean;
  /** Something was given but couldn't be read as an amount. */
  isInvalid: boolean;
}

/** Parse a typed or pasted bank balance and compare it against the cleared balance. */
export function compareToClearedBalance(
  clearedBalance: number,
  input: string,
): ReconcileComparison {
  const trimmed = (input ?? '').trim();
  if (trimmed === '') {
    return {
      clearedBalance,
      targetBalance: null,
      difference: null,
      isBalanced: false,
      isInvalid: false,
    };
  }

  const parsed = looselyParseAmount(trimmed);
  if (parsed == null || !Number.isFinite(parsed)) {
    return {
      clearedBalance,
      targetBalance: null,
      difference: null,
      isBalanced: false,
      isInvalid: true,
    };
  }

  return compareCentsToClearedBalance(clearedBalance, Math.round(parsed * 100));
}

/** The same comparison when the bank balance is already integer cents. */
export function compareCentsToClearedBalance(
  clearedBalance: number,
  targetBalance: number,
): ReconcileComparison {
  const difference = targetBalance - clearedBalance;
  return {
    clearedBalance,
    targetBalance,
    difference,
    isBalanced: difference === 0,
    isInvalid: false,
  };
}

export interface ReconcileAdjustment {
  /** Always positive, in minor units — the sign lives in `type`. */
  amount: number;
  type: 'income' | 'expense';
  payee: string;
  notes: string;
}

/**
 * Describe the single transaction that would close a non-zero difference.
 * Returns `null` for a zero or absent difference.
 */
export function buildReconcileAdjustment(
  difference: number | null,
  todayIso: string,
): ReconcileAdjustment | null {
  if (difference == null || difference === 0) return null;
  return {
    amount: Math.abs(difference),
    // A positive difference means the bank has more than arc counted, so the
    // adjustment has to add money to the account.
    type: difference > 0 ? 'income' : 'expense',
    payee: RECONCILE_ADJUSTMENT_PAYEE,
    notes: `Reconciled ${todayIso}`,
  };
}

/** Human summary of the gap. `format` is injected to keep currency formatting out. */
export function describeDifference(
  difference: number,
  format: (cents: number) => string,
): string {
  const magnitude = format(Math.abs(difference));
  return difference > 0
    ? `Your bank has ${magnitude} more than arc has cleared.`
    : `arc has ${magnitude} more cleared than your bank.`;
}

/** The subset of a ledger row the cleared-balance sum reads. */
export interface ClearedRow {
  id: string;
  date: string;
  amount?: number | null;
  cleared?: boolean | null;
  reconciled?: boolean | null;
  is_child?: boolean | null;
  tombstone?: boolean | null;
  subtransactions?: ClearedRow[] | null;
}

/**
 * The cleared balance of top-level rows dated on or before `asOf` (all rows
 * when absent), plus the ids a reconciliation would lock: every cleared row
 * not already reconciled, split children included so the whole split locks.
 *
 * Takes grouped rows as `getTransactions` returns them — a split parent's
 * amount is the sum of its children, so counting top-level rows only is
 * exact.
 */
export function clearedBalanceOf(rows: ClearedRow[], asOf?: string): { clearedBalance: number; toLock: string[] } {
  let clearedBalance = 0;
  const toLock: string[] = [];
  for (const t of rows) {
    if (t.tombstone || t.is_child || !t.cleared) continue;
    if (asOf && t.date > asOf) continue;
    clearedBalance += t.amount ?? 0;
    if (!t.reconciled) toLock.push(t.id);
    for (const child of t.subtransactions ?? []) {
      if (!child.tombstone && !child.reconciled) toLock.push(child.id);
    }
  }
  return { clearedBalance, toLock };
}
