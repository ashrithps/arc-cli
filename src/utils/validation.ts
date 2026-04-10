import type { TransactionCreate, SubTransaction } from '../types.js';

/**
 * Validate and coerce an amount to integer cents.
 */
export function validateAmount(input: any): number {
  const num = typeof input === 'string' ? parseFloat(input) : input;
  if (typeof num !== 'number' || isNaN(num) || !isFinite(num)) {
    throw new Error(`Invalid amount: "${input}". Must be a number.`);
  }
  return Math.round(num);
}

/**
 * Validate a human-readable amount and convert to cents.
 * Accepts "12.34" or "-50.00" and returns 1234 or -5000.
 */
export function validateHumanAmount(input: any): number {
  const num = typeof input === 'string' ? parseFloat(input) : input;
  if (typeof num !== 'number' || isNaN(num) || !isFinite(num)) {
    throw new Error(`Invalid amount: "${input}". Must be a number.`);
  }
  return Math.round(num * 100);
}

/**
 * Validate a date string in YYYY-MM-DD format.
 */
export function validateDate(input: any): string {
  if (typeof input !== 'string') throw new Error(`Invalid date: expected string, got ${typeof input}`);
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid date format: "${input}". Expected YYYY-MM-DD.`);
  const d = new Date(`${input}T00:00:00Z`);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: "${input}"`);
  return input;
}

/**
 * Validate a month string in YYYY-MM format.
 */
export function validateMonth(input: any): string {
  if (typeof input !== 'string') throw new Error(`Invalid month: expected string, got ${typeof input}`);
  if (!/^\d{4}-\d{2}$/.test(input)) throw new Error(`Invalid month format: "${input}". Expected YYYY-MM.`);
  return input;
}

/**
 * Validate a non-empty string ID.
 */
export function validateId(input: any): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`Invalid ID: "${input}". Must be a non-empty string.`);
  }
  return input.trim();
}

/**
 * Validate a non-empty name string.
 */
export function validateName(input: any): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`Invalid name: must be a non-empty string.`);
  }
  return input.trim();
}

/**
 * Validate a transaction create object.
 */
export function validateTransaction(tx: any): TransactionCreate {
  if (!tx || typeof tx !== 'object') throw new Error('Transaction must be an object.');
  if (!tx.date) throw new Error('Transaction requires a date.');

  const result: TransactionCreate = {
    date: validateDate(tx.date),
  };

  if (tx.amount != null) result.amount = validateAmount(tx.amount);
  if (tx.payee_name) result.payee_name = String(tx.payee_name);
  if (tx.payee) result.payee = validateId(tx.payee);
  if (tx.category) result.category = validateId(tx.category);
  if (tx.notes) result.notes = String(tx.notes);
  if (tx.imported_id) result.imported_id = String(tx.imported_id);
  if (tx.imported_payee) result.imported_payee = String(tx.imported_payee);
  if (tx.cleared != null) result.cleared = Boolean(tx.cleared);
  if (tx.account) result.account = validateId(tx.account);

  if (tx.subtransactions && Array.isArray(tx.subtransactions)) {
    result.subtransactions = tx.subtransactions.map((s: any) => validateSubTransaction(s));
  }

  return result;
}

/**
 * Validate a subtransaction.
 */
export function validateSubTransaction(sub: any): SubTransaction {
  if (!sub || typeof sub !== 'object') throw new Error('Subtransaction must be an object.');

  const result: SubTransaction = {
    amount: validateAmount(sub.amount),
  };

  if (sub.category) result.category = validateId(sub.category);
  if (sub.notes) result.notes = String(sub.notes);

  return result;
}

/**
 * Validate that split subtransaction amounts sum to the parent amount.
 * Throws if they don't match.
 */
export function validateSplitAmounts(parentAmount: number, subtransactions: SubTransaction[]): void {
  if (subtransactions.length === 0) {
    throw new Error('Split transaction must have at least one subtransaction.');
  }

  const subTotal = subtransactions.reduce((sum, s) => sum + s.amount, 0);

  if (Math.abs(subTotal - parentAmount) > 1) {
    throw new Error(
      `Split amounts don't match parent. ` +
      `Parent: ${parentAmount}, Subtotal: ${subTotal}, Difference: ${parentAmount - subTotal}`
    );
  }
}
