import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import type { BudgetMonth } from '../types.js';
import { validateMonth, validateId, validateAmount } from '../utils/validation.js';

export async function getBudgetMonths(client: ActualClient): Promise<string[]> {
  client.ensureConnected();
  return await client.api.getBudgetMonths();
}

export async function getBudgetMonth(client: ActualClient, month: string): Promise<BudgetMonth> {
  client.ensureConnected();
  validateMonth(month);
  return await client.api.getBudgetMonth(month);
}

export async function setBudgetAmount(
  client: ActualClient,
  writer: SafeWriter,
  month: string,
  categoryId: string,
  amount: number
): Promise<void> {
  validateMonth(month);
  validateId(categoryId);
  const cents = validateAmount(amount);

  const result = await writer.write(
    `Set budget: ${month} / ${categoryId} = ${cents}`,
    () => client.api.setBudgetAmount(month, categoryId, cents)
  );

  if (!result.success) throw new Error(result.error);
}

export async function setBudgetCarryover(
  client: ActualClient,
  writer: SafeWriter,
  month: string,
  categoryId: string,
  flag: boolean
): Promise<void> {
  validateMonth(month);
  validateId(categoryId);

  // Actual's setBudgetCarryover throws "No budget exists for month: …"
  // when the month record hasn't been materialized yet (typical for far-
  // future months). setBudgetAmount creates the month record as a side
  // effect, so we call it first with the current value to be a no-op
  // that still materialises the month. This avoids exposing an Actual
  // implementation detail to callers.
  let current = 0;
  try {
    const budget = await client.api.getBudgetMonth(month);
    for (const g of (budget as any).categoryGroups || []) {
      for (const c of g.categories || []) {
        if (c.id === categoryId) current = c.budgeted || 0;
      }
    }
  } catch (err: any) {
    if (!/no budget exists for month/i.test(err?.message || '')) throw err;
  }

  const result = await writer.write(
    `Set carryover: ${month} / ${categoryId} = ${flag}`,
    async () => {
      await client.api.setBudgetAmount(month, categoryId, current);
      await client.api.setBudgetCarryover(month, categoryId, flag);
    }
  );

  if (!result.success) {
    if (/no budget exists for month/i.test(result.error || '')) {
      throw new Error(
        `Cannot set carryover for ${month}: Actual has no budget data for that month yet. ` +
        `Carryover only works on months that have been materialised — use a current or near-future month.`
      );
    }
    throw new Error(result.error);
  }
}

export async function batchBudgetUpdate(
  client: ActualClient,
  writer: SafeWriter,
  fn: () => Promise<void>
): Promise<void> {
  const result = await writer.write(
    'Batch budget update',
    () => client.api.batchBudgetUpdates(fn)
  );

  if (!result.success) throw new Error(result.error);
}

/**
 * Transfer budget between two categories in the same month.
 * Subtracts from source, adds to destination.
 */
export async function transferBudget(
  client: ActualClient,
  writer: SafeWriter,
  month: string,
  fromCategoryId: string,
  toCategoryId: string,
  amount: number
): Promise<void> {
  validateMonth(month);
  validateId(fromCategoryId);
  validateId(toCategoryId);
  if (amount <= 0) throw new Error('Transfer amount must be positive.');
  if (fromCategoryId === toCategoryId) throw new Error('Cannot transfer to the same category.');

  const cents = validateAmount(amount);

  // Get current amounts. Actual's getBudgetMonth throws "No budget exists
  // for month: …" for months it has not materialized yet (typically far-
  // future months). setBudgetAmount on the same month works fine because
  // it implicitly creates the month record. Tolerate the missing month
  // by treating both current values as 0 — the new amounts we set below
  // become the canonical values for that month.
  let fromCurrent = 0;
  let toCurrent = 0;
  try {
    const budget = await client.api.getBudgetMonth(month);
    for (const g of (budget as any).categoryGroups || []) {
      for (const c of g.categories || []) {
        if (c.id === fromCategoryId) fromCurrent = c.budgeted || 0;
        if (c.id === toCategoryId) toCurrent = c.budgeted || 0;
      }
    }
  } catch (err: any) {
    if (!/no budget exists for month/i.test(err?.message || '')) throw err;
  }

  const result = await writer.write(
    `Transfer budget: ${month} ${cents} cents`,
    async () => {
      await client.api.setBudgetAmount(month, fromCategoryId, fromCurrent - cents);
      await client.api.setBudgetAmount(month, toCategoryId, toCurrent + cents);
    }
  );

  if (!result.success) throw new Error(result.error);
}

/**
 * Get income summary for a month.
 *
 * Actual's per-category `spent` is always 0 for income categories — they
 * track budgeted *targets*, not received money. The total received income
 * lives at `budget.totalIncome`. For per-category received amounts we
 * have to scan the transaction ledger and group by category id, since the
 * budget object doesn't break down received income by category.
 *
 * Returns:
 *   totalReceived  — sum of all positive (and negative) flows through
 *                    income categories in the month, taken from
 *                    budget.totalIncome (matches what the Actual UI shows).
 *   totalBudgeted  — sum of budgeted amounts on income categories
 *                    (planned income targets, often 0 for users who don't
 *                    actively budget the income side).
 *   categories     — per-category breakdown:
 *                      budgeted: planned amount on the category
 *                      received: sum of transactions in the category for
 *                                this month (computed from the ledger)
 */
export async function getIncomeForMonth(
  client: ActualClient,
  month: string
): Promise<{
  totalReceived: number;
  totalBudgeted: number;
  categories: { id: string; name: string; budgeted: number; received: number }[];
}> {
  client.ensureConnected();
  validateMonth(month);

  const budget = await client.api.getBudgetMonth(month);
  const totalReceived = (budget as any).totalIncome ?? 0;
  let totalBudgeted = 0;
  const incomeCats: { id: string; name: string; budgeted: number; received: number }[] = [];

  for (const g of (budget as any).categoryGroups || []) {
    if (!g.is_income) continue;
    for (const c of g.categories || []) {
      totalBudgeted += c.budgeted || 0;
      incomeCats.push({ id: c.id, name: c.name, budgeted: c.budgeted || 0, received: 0 });
    }
  }

  // Compute received-per-category from the ledger. We iterate every
  // account's transactions in the month window and accumulate by
  // category id. This is O(accounts) sequential reads but cheap because
  // each call is a SQLite scan over a small date range.
  if (incomeCats.length > 0) {
    const start = `${month}-01`;
    // End of month: use day 31 since Actual's getTransactions tolerates
    // overshoot dates and returns the same result as the real last day.
    const end = `${month}-31`;
    const accounts = await client.api.getAccounts();
    const byCat: Record<string, number> = {};
    for (const a of accounts) {
      try {
        const txns = await client.api.getTransactions((a as any).id, start, end);
        for (const t of txns) {
          if ((t as any).is_child) continue;
          const cat = (t as any).category;
          if (!cat) continue;
          byCat[cat] = (byCat[cat] || 0) + ((t as any).amount || 0);
        }
      } catch { /* skip account on error */ }
    }
    for (const c of incomeCats) {
      c.received = byCat[c.id] || 0;
    }
  }

  return { totalReceived, totalBudgeted, categories: incomeCats };
}

/**
 * Get total budgeted across all expense categories for a month.
 */
export async function getTotalBudgeted(
  client: ActualClient,
  month: string
): Promise<{ totalBudgeted: number; totalSpent: number; totalBalance: number; toBudget: number }> {
  client.ensureConnected();
  validateMonth(month);

  const budget = await client.api.getBudgetMonth(month);
  let totalBudgeted = 0;
  let totalSpent = 0;
  let totalBalance = 0;

  for (const g of (budget as any).categoryGroups || []) {
    if (g.is_income) continue;
    for (const c of g.categories || []) {
      totalBudgeted += c.budgeted || 0;
      totalSpent += c.spent || 0;
      totalBalance += c.balance || 0;
    }
  }

  return {
    totalBudgeted,
    totalSpent,
    totalBalance,
    toBudget: (budget as any).toBudget || 0,
  };
}
