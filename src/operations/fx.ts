import type { ActualClient } from '../client.js';
import type { Rule } from '../types.js';

/**
 * FX (foreign exchange) helpers.
 *
 * Many Actual users set up "FX accounts" — accounts that hold balances in
 * a non-base currency (INR, AED, EUR, GBP, etc.). The convention they use
 * is to install a `post`-stage rule per FX account that:
 *
 *   1. Multiplies every incoming transaction's amount by an FX rate
 *      (`mul amount 0.01109` for INR→USD, for example), so the budget
 *      file stores everything in the base currency's minor units (cents).
 *   2. Prepends the original native amount and rate to the notes:
 *      `"500.00 INR (FX rate: 0.01109) • Original notes"`
 *
 * This module exposes those rules to the rest of arc so that read tools
 * can return:
 *   - the account's native currency code
 *   - the FX rate
 *   - the recovered native amount per transaction
 *
 * Agents reading the data can then present numbers in the user's native
 * currency without ever guessing.
 */

export interface FxAccountMetadata {
  /** ISO-4217 currency code parsed from the rule's notes template. */
  currency: string;
  /** The multiplier applied to native amounts to convert into base cents. */
  rate: number;
}

export interface FxNote {
  /** Native-currency amount in minor units (negative for debits). */
  nativeAmount: number;
  /** ISO-4217 currency code (e.g. "INR", "AED", "EUR"). */
  currency: string;
  /** The FX rate that was applied to produce the stored base-currency amount. */
  rate: number;
  /** The notes payload after stripping the FX prefix. */
  cleanNotes: string;
}

/**
 * Inspect the user's transaction rules and find the FX rule (if any) that
 * targets `accountId`. Returns the parsed currency + rate, or null if no
 * matching rule is configured.
 */
export function parseFxAccountMetadata(rules: Rule[], accountId: string): FxAccountMetadata | null {
  for (const rule of rules) {
    if (rule.stage !== 'post') continue;
    const hasAccountCondition = rule.conditions?.some(
      (c: any) => c.field === 'account' && c.op === 'is' && c.value === accountId
    );
    if (!hasAccountCondition) continue;

    const noteAction = rule.actions?.find((a: any) => a.field === 'notes' && typeof a.value === 'string');
    const amountAction = rule.actions?.find((a: any) => a.field === 'amount');
    const noteTemplate = String((noteAction as any)?.value || (noteAction as any)?.options?.template || '');
    const amountTemplate = String((amountAction as any)?.options?.template || (amountAction as any)?.value || '');

    // Note template looks like: "{{native_amount}} INR (FX rate: 0.01109) • {{notes}}"
    const noteMatch = noteTemplate.match(/\}\}\s+([A-Z]{3})\s+\(FX rate:\s*([0-9.]+)\)/);
    // Amount template looks like: "mul amount 0.01109"
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

/**
 * Build a map of accountId → { currency, rate } for every account that has
 * an FX rule configured. Returns an empty object when there are no rules.
 *
 * Use this when annotating large lists (accounts, transactions) so the
 * caller can do an O(1) lookup per row instead of scanning rules each time.
 */
export async function getAccountFxMap(client: ActualClient): Promise<Record<string, FxAccountMetadata>> {
  client.ensureConnected();
  let rules: Rule[];
  try {
    rules = await client.api.getRules();
  } catch {
    return {};
  }
  if (!rules || rules.length === 0) return {};

  const accounts = await client.api.getAccounts();
  const out: Record<string, FxAccountMetadata> = {};
  for (const a of accounts) {
    const meta = parseFxAccountMetadata(rules, (a as any).id);
    if (meta) out[(a as any).id] = meta;
  }
  return out;
}

/**
 * Parse the FX prefix that an FX rule prepends to a transaction's notes.
 *
 * Recognises every variant we have seen in real budgets:
 *   "500.00 INR (FX rate: 0.01109) • Coffee Shop"
 *   "₹1,543.27 INR (FX rate: 0.01109)"            (rupee symbol prefix)
 *   "$50.00 USD (FX rate: 1.0)"                    (dollar prefix)
 *   "-1,234.56 INR (FX rate: 0.01109)"             (no leading symbol)
 *
 * The native amount is returned as a positive integer in minor units —
 * FX rules typically format the prefix without a sign because the stored
 * base-currency amount carries the direction. Callers that want a signed
 * native should apply `Math.sign(baseAmount)` themselves.
 *
 * Returns null when the notes don't match the pattern.
 */
export function parseFxNote(notes: string | null | undefined): FxNote | null {
  if (!notes) return null;
  // Optional currency-symbol prefix (₹, $, €, £, ¥, Rs, AED, …) — anything
  // that isn't a digit or a minus sign at the start of the string. Then
  // optional minus, digits with optional thousands separators and decimals,
  // a 3-letter currency code, the (FX rate: N) marker, and an optional
  // " • rest" tail.
  const match = notes.match(
    /^\s*[^\d-]*?(-?[\d,]+(?:\.\d+)?)\s+([A-Z]{3})\s+\(FX rate:\s*([0-9.]+)\)\s*(?:•\s*(.*))?$/
  );
  if (!match) return null;

  const [, rawAmount, currency, rawRate, tail] = match;
  const native = parseFloat(rawAmount.replace(/,/g, ''));
  const rate = parseFloat(rawRate);
  if (!Number.isFinite(native) || !Number.isFinite(rate)) return null;

  return {
    nativeAmount: Math.round(Math.abs(native) * 100),
    currency,
    rate,
    cleanNotes: (tail || '').trim(),
  };
}
