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

  const result = await writer.write(
    `Set carryover: ${month} / ${categoryId} = ${flag}`,
    () => client.api.setBudgetCarryover(month, categoryId, flag)
  );

  if (!result.success) throw new Error(result.error);
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

  // Get current amounts
  const budget = await client.api.getBudgetMonth(month);
  let fromCurrent = 0;
  let toCurrent = 0;
  for (const g of (budget as any).categoryGroups || []) {
    for (const c of g.categories || []) {
      if (c.id === fromCategoryId) fromCurrent = c.budgeted || 0;
      if (c.id === toCategoryId) toCurrent = c.budgeted || 0;
    }
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
 * Get income summary for a month — total income budgeted/spent/balance.
 */
export async function getIncomeForMonth(
  client: ActualClient,
  month: string
): Promise<{ totalBudgeted: number; totalSpent: number; totalBalance: number; categories: any[] }> {
  client.ensureConnected();
  validateMonth(month);

  const budget = await client.api.getBudgetMonth(month);
  let totalBudgeted = 0;
  let totalSpent = 0;
  let totalBalance = 0;
  const incomeCats: any[] = [];

  for (const g of (budget as any).categoryGroups || []) {
    if (!g.is_income) continue;
    for (const c of g.categories || []) {
      totalBudgeted += c.budgeted || 0;
      totalSpent += c.spent || 0;
      totalBalance += c.balance || 0;
      incomeCats.push({ name: c.name, budgeted: c.budgeted || 0, spent: c.spent || 0, balance: c.balance || 0 });
    }
  }

  return { totalBudgeted, totalSpent, totalBalance, categories: incomeCats };
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
