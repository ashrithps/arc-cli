import type { ActualClient } from '../client.js';
import type { Transaction } from '../types.js';
import { formatCurrency } from '../utils/format.js';

export async function runCustomQuery(client: ActualClient, query: any): Promise<any> {
  client.ensureConnected();
  return await client.api.runQuery(query);
}

export async function getTransactionsByPayee(
  client: ActualClient,
  payeeName: string,
  limit?: number
): Promise<Transaction[]> {
  client.ensureConnected();

  // Get all accounts and search for matching payee transactions
  const accounts = await client.api.getAccounts();
  const allTxns: Transaction[] = [];

  for (const account of accounts) {
    const txns = await client.api.getTransactions((account as any).id);
    allTxns.push(...txns);
  }

  const lower = payeeName.toLowerCase();
  let matches = allTxns.filter((t: any) =>
    (t.payee_name || '').toLowerCase().includes(lower) ||
    (t.imported_payee || '').toLowerCase().includes(lower) ||
    (t.notes || '').toLowerCase().includes(lower)
  );

  // Sort by date descending
  matches.sort((a: any, b: any) => b.date.localeCompare(a.date));

  if (limit) matches = matches.slice(0, limit);
  return matches;
}

export async function getTransactionsByCategory(
  client: ActualClient,
  categoryName: string,
  startDate?: string,
  endDate?: string
): Promise<Transaction[]> {
  client.ensureConnected();

  // Find category ID
  const groups = await client.api.getCategoryGroups();
  let categoryId: string | null = null;
  const lower = categoryName.toLowerCase();

  for (const group of groups) {
    for (const cat of (group as any).categories || []) {
      if (cat.name.toLowerCase() === lower || cat.name.toLowerCase().includes(lower)) {
        categoryId = cat.id;
        break;
      }
    }
    if (categoryId) break;
  }

  if (!categoryId) {
    throw new Error(`Category not found: "${categoryName}"`);
  }

  const accounts = await client.api.getAccounts();
  const allTxns: Transaction[] = [];

  for (const account of accounts) {
    const txns = await client.api.getTransactions((account as any).id, startDate, endDate);
    allTxns.push(...txns.filter((t: any) => t.category === categoryId));
  }

  allTxns.sort((a: any, b: any) => b.date.localeCompare(a.date));
  return allTxns;
}

export async function getSpendingSummary(
  client: ActualClient,
  month: string
): Promise<{ category: string; categoryId: string; spent: number; budgeted: number; balance: number }[]> {
  client.ensureConnected();

  const budget = await client.api.getBudgetMonth(month);
  const summary: any[] = [];

  for (const group of (budget as any).categoryGroups || []) {
    for (const cat of group.categories || []) {
      summary.push({
        category: cat.name,
        categoryId: cat.id,
        spent: cat.spent || 0,
        budgeted: cat.budgeted || 0,
        balance: cat.balance || 0,
      });
    }
  }

  // Sort by spent (most spending first)
  summary.sort((a, b) => a.spent - b.spent);
  return summary;
}

export async function getAccountSummary(
  client: ActualClient
): Promise<{ name: string; id: string; type: string; balance: number; offbudget: boolean; closed: boolean }[]> {
  client.ensureConnected();

  const accounts = await client.api.getAccounts();
  // Actual's getAccounts() does not expose a balance field. Compute each
  // account's balance from its transactions in parallel — same approach
  // used by operations/accounts.ts listAccounts(). Skipping is_child
  // transactions avoids double-counting splits.
  const balances = await Promise.all(
    accounts.map(async (a: any) => {
      try {
        const txns = await client.api.getTransactions(a.id);
        let bal = 0;
        for (const t of txns) {
          if (!t.is_child) bal += t.amount ?? 0;
        }
        return bal;
      } catch {
        return 0;
      }
    })
  );
  return accounts.map((a: any, i: number) => ({
    name: a.name,
    id: a.id,
    type: a.type || 'checking',
    balance: balances[i],
    offbudget: a.offbudget || false,
    closed: a.closed || false,
  }));
}

/**
 * Get spending trends across multiple months — category-by-category comparison.
 */
export async function getSpendingTrends(
  client: ActualClient,
  months: number = 3
): Promise<{ category: string; months: { month: string; spent: number }[] }[]> {
  client.ensureConnected();

  // Get last N months
  const now = new Date();
  const monthKeys: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  monthKeys.reverse();

  // Collect spending per category per month
  const catData: Record<string, Record<string, number>> = {};
  const catNames: Record<string, string> = {};

  for (const m of monthKeys) {
    try {
      const budget = await client.api.getBudgetMonth(m);
      for (const g of (budget as any).categoryGroups || []) {
        if (g.is_income) continue;
        for (const c of g.categories || []) {
          if (!catData[c.id]) catData[c.id] = {};
          catData[c.id][m] = c.spent || 0;
          catNames[c.id] = c.name;
        }
      }
    } catch {}
  }

  // Build result, filter categories with any spending
  return Object.entries(catData)
    .map(([id, data]) => ({
      category: catNames[id] || id,
      months: monthKeys.map(m => ({ month: m, spent: data[m] || 0 })),
      totalSpent: Object.values(data).reduce((s, v) => s + v, 0),
    }))
    .filter((c: any) => c.totalSpent !== 0)
    .sort((a: any, b: any) => a.totalSpent - b.totalSpent) // most spending first (negative)
    .map(({ category, months: m }) => ({ category, months: m }));
}

/**
 * Get top spending categories for a month, ranked by amount.
 */
export async function getTopCategories(
  client: ActualClient,
  month: string,
  limit: number = 10
): Promise<{ rank: number; category: string; spent: number; budgeted: number; pct: number }[]> {
  client.ensureConnected();

  const budget = await client.api.getBudgetMonth(month);
  const cats: { category: string; spent: number; budgeted: number }[] = [];

  for (const g of (budget as any).categoryGroups || []) {
    if (g.is_income) continue;
    for (const c of g.categories || []) {
      if ((c.spent || 0) !== 0) {
        cats.push({ category: c.name, spent: c.spent || 0, budgeted: c.budgeted || 0 });
      }
    }
  }

  // Sort by absolute spent (most spending first)
  cats.sort((a, b) => Math.abs(b.spent) - Math.abs(a.spent));

  const totalSpent = cats.reduce((s, c) => s + Math.abs(c.spent), 0);

  return cats.slice(0, limit).map((c, i) => ({
    rank: i + 1,
    category: c.category,
    spent: c.spent,
    budgeted: c.budgeted,
    pct: totalSpent > 0 ? Math.round((Math.abs(c.spent) / totalSpent) * 100) : 0,
  }));
}

/**
 * Monthly totals summary — total in/out/net per month over N months.
 */
export async function getMonthlyTotals(
  client: ActualClient,
  months: number = 6
): Promise<{ month: string; income: number; expenses: number; net: number }[]> {
  client.ensureConnected();

  const now = new Date();
  const results: { month: string; income: number; expenses: number; net: number }[] = [];

  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

    try {
      const budget = await client.api.getBudgetMonth(m);

      // Income comes from the top-level totalIncome field on the budget
      // object, not from summing per-category `spent` on income groups.
      // In Actual, income categories track BUDGETED targets, not received
      // amounts — `c.spent` is always 0 for income categories. The actual
      // received income is aggregated into `budget.totalIncome` by Actual
      // itself. (This is why every monthly income previously read as 0.)
      const income = (budget as any).totalIncome ?? 0;

      let expenses = 0;
      for (const g of (budget as any).categoryGroups || []) {
        if (g.is_income) continue;
        for (const c of g.categories || []) {
          expenses += c.spent || 0;
        }
      }

      results.push({ month: m, income, expenses, net: income + expenses });
    } catch {
      results.push({ month: m, income: 0, expenses: 0, net: 0 });
    }
  }

  results.reverse();
  return results;
}

export async function getUncategorizedTransactions(
  client: ActualClient,
  accountId?: string
): Promise<Transaction[]> {
  client.ensureConnected();

  const accounts = accountId
    ? [{ id: accountId }]
    : await client.api.getAccounts();

  const uncategorized: Transaction[] = [];

  for (const account of accounts) {
    const txns = await client.api.getTransactions((account as any).id);
    uncategorized.push(
      ...txns.filter((t: any) =>
        !t.category &&
        !t.is_parent &&
        !t.is_child &&
        !t.transfer_id &&
        !(t as any).starting_balance_flag
      )
    );
  }

  uncategorized.sort((a: any, b: any) => b.date.localeCompare(a.date));
  return uncategorized;
}

/**
 * Get daily balance history for an account over N months.
 * Computes running balance from all transactions.
 */
export async function getBalanceHistory(
  client: ActualClient,
  accountId: string,
  months: number = 6
): Promise<{ date: string; balance: number; dailyChange: number }[]> {
  client.ensureConnected();

  const txns = await client.api.getTransactions(accountId);

  // Sort oldest first
  const sorted = [...txns]
    .filter((t: any) => !t.is_child)
    .sort((a: any, b: any) => a.date.localeCompare(b.date));

  if (sorted.length === 0) return [];

  // Compute running balance per day
  const dailyMap: Record<string, number> = {};
  let runningBal = 0;

  for (const t of sorted) {
    runningBal += t.amount || 0;
    dailyMap[t.date] = runningBal;
  }

  // Filter to last N months
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - months, 1)
    .toISOString().slice(0, 10);

  // Build daily entries (fill gaps with previous balance)
  const dates = Object.keys(dailyMap).sort();
  const allDates = dates.filter(d => d >= cutoff);

  // Compute daily change
  let prevBal = 0;
  const result: { date: string; balance: number; dailyChange: number }[] = [];

  // Find the balance just before cutoff
  for (const d of dates) {
    if (d < cutoff) prevBal = dailyMap[d];
    else break;
  }

  for (const d of allDates) {
    const bal = dailyMap[d];
    result.push({ date: d, balance: bal, dailyChange: bal - prevBal });
    prevBal = bal;
  }

  return result;
}

/**
 * Get monthly balance snapshots for an account (end-of-month balances).
 */
export async function getMonthlyBalances(
  client: ActualClient,
  accountId: string,
  months: number = 12
): Promise<{ month: string; balance: number; change: number }[]> {
  client.ensureConnected();

  const history = await getBalanceHistory(client, accountId, months);
  if (history.length === 0) return [];

  // Group by month, take last entry per month
  const byMonth: Record<string, number> = {};
  for (const h of history) {
    const m = h.date.slice(0, 7);
    byMonth[m] = h.balance;
  }

  const monthKeys = Object.keys(byMonth).sort();
  let prevBal = 0;
  return monthKeys.map(m => {
    const bal = byMonth[m];
    const change = bal - prevBal;
    prevBal = bal;
    return { month: m, balance: bal, change };
  });
}
