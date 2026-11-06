// Ported near-verbatim from the arc app (budgetarc utils/statementFees.ts, 1.0.50).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * Fees and charges, and the ones worth asking back (intel #5/#9, §2). Summed
 * from the account's own rows, never estimated. The checks are suggestions
 * with a reason, each dismissible for good, and a matching reversal closes
 * one by itself.
 *
 * Checks, kept to what the rules say (copy rules in the research doc: never
 * a US dollar cap):
 * - India: a late fee when the payment arrived 1–3 days after the due date.
 *   RBI allows late charges only once a card is past due for more than three
 *   days, counted from the statement's due date (Credit Card Directions 2022,
 *   para 23(5), unchanged by the 2026 amendment; checked 2026-11-05).
 * - Everywhere: the first late fee in 12 months on a card paid in full since.
 *   Some banks take a first one back when asked (practice, not a rule).
 */
import { debtChargeKind } from './debt-charges.js';
import { bankLineKind } from './statement-bank-lines.js';

export interface FeeRow {
  id: string;
  date: string;
  /** Signed cents, as arc stores them: a charge is negative. */
  amount: number;
  text: string;
}

const EDGE = '[A-Za-z0-9À-ɏ]';
const words = (alternatives: string[]) => new RegExp(`(?:^|(?!${EDGE}).)(?:${alternatives.join('|')})(?!${EDGE})`, 'i');
const LATE = words([
  'late (?:payment )?(?:fee|charges?)', 'lpf', 'mahngeb[üu]hr', 'versp[äa]tungsgeb[üu]hr', 'frais de retard', 'p[ée]nalit[ée] de retard',
  'comisi[óo]n por (?:demora|impago)', 'recargo por demora', 'penale(?: di ritardo)?', 'mora', 'boete', 'aanmaningskosten', 'multa(?: por atraso)?',
]);
const LATE_CJK = /遅延損害金|延滞|滞纳金|逾期/;
const TAX = words(['(?:i|c|s)?gst', 'service tax', 'vat', 'iva', 'iof']);

// Money back from the bank, not a payment: never counts toward paying the card.
const MONEY_BACK = words(['reversal', 'reversed', 'refund(?:ed)?', 'waiver', 'waived', 'cashback', 'cash back', 'credit adj', 'storno', 'r[üu]ckerstattung', 'gutschrift', 'remboursement', 'reembolso', 'estorno', 'rimborso', 'terugbetaling']);
const MONEY_BACK_CJK = /返金|退款|冲正|返现/;

/** Money into a card that pays it (not a refund or a fee taken back). */
export function isCardPayment(row: { amount: number; text: string }): boolean {
  return row.amount > 0 && !MONEY_BACK.test(row.text) && !MONEY_BACK_CJK.test(row.text);
}

export type FeeKind = 'late' | 'tax' | 'fee';

/**
 * A charge row's kind, or null when it isn't one. On a card only the
 * bank's fee words count ("UNIVERSITY FEES" is a purchase); on a bank
 * account its charge lines do too.
 */
export function feeKind(row: FeeRow, card = true): FeeKind | null {
  if (row.amount >= 0) return null;
  const t = row.text;
  // The tax on a late fee is tax, not a second late fee.
  if (TAX.test(t) || bankLineKind(t) === 'tax') return 'tax';
  if (LATE.test(t) || LATE_CJK.test(t)) return 'late';
  if (debtChargeKind(t) === 'fee' || (!card && bankLineKind(t) === 'charge')) return 'fee';
  return null;
}

export interface FeeLedger {
  /** All fees in the window, positive cents. */
  total: number;
  /** The tax charged on them, positive cents. */
  tax: number;
  count: number;
}

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** The last 12 months' fees, from rows (refunded ones included: the reversal is money back, shown apart). */
export function feeLedger(rows: FeeRow[], today: string, card: boolean): FeeLedger {
  const from = addDays(today, -365);
  const fees = rows.filter((r) => r.date > from && r.date <= today && feeKind(r, card));
  return {
    total: fees.reduce((s, r) => s - r.amount, 0),
    tax: fees.filter((r) => feeKind(r, card) === 'tax').reduce((s, r) => s - r.amount, 0),
    count: fees.length,
  };
}

export interface AskBack {
  feeId: string;
  date: string;
  /** Positive cents. */
  amount: number;
  why: 'grace' | 'first';
  /** grace: how many days after the due date the payment arrived. */
  daysLate?: number;
  /** The due date it was late for. */
  due?: string;
}

/** A credit of the same amount within 60 days: the bank took it back. */
function reversed(fee: FeeRow, rows: FeeRow[]): boolean {
  return rows.some((r) => r.amount === -fee.amount && r.date >= fee.date && daysBetween(fee.date, r.date) <= 60);
}

/**
 * Late fees worth asking back, newest first. `statements` are the account's
 * filed statements with the due date each had and what it asked for;
 * `payments` are money into the card (positive cents).
 */
export function worthAskingBack(input: {
  rows: FeeRow[];
  payments: Array<{ date: string; amount: number }>;
  statements: Array<{ end: string; due: string | null; owed: number }>;
  currency: string | null;
  today: string;
  dismissed?: string[];
}): AskBack[] {
  const { rows, payments, statements, today } = input;
  const dismissed = new Set(input.dismissed ?? []);
  const lates = rows.filter((r) => feeKind(r) === 'late' && daysBetween(r.date, today) <= 120).sort((a, b) => (a.date < b.date ? 1 : -1));
  const out: AskBack[] = [];
  for (const fee of lates) {
    if (dismissed.has(fee.id) || reversed(fee, rows)) continue;
    // The statement whose due date this fee was charged for: the latest due on or before the fee.
    const stmt = statements.filter((s) => s.due && s.due <= fee.date).sort((a, b) => (a.due! < b.due! ? 1 : -1))[0];
    if (input.currency === 'INR' && stmt?.due) {
      // Only the user's own payment row in arc, dated 1–3 days late, says so. With none (paid from an
      // account arc doesn't track), say nothing: arc can't know when the money arrived.
      const paid = payments.filter((p) => p.date > stmt.end && p.amount > 0).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      const late = paid ? daysBetween(stmt.due, paid.date) : null;
      if (late !== null && late >= 1 && late <= 3) {
        out.push({ feeId: fee.id, date: fee.date, amount: -fee.amount, why: 'grace', daysLate: late, due: stmt.due });
        continue;
      }
    }
    // The first late fee in 12 months, on a card paid in full since.
    const earlier = rows.some((r) => r.id !== fee.id && feeKind(r) === 'late' && r.date < fee.date && daysBetween(r.date, fee.date) <= 365);
    const billed = statements.filter((s) => s.end >= fee.date).sort((a, b) => (a.end < b.end ? -1 : 1))[0];
    const paidSince = billed ? payments.filter((p) => p.date > billed.end).reduce((s, p) => s + p.amount, 0) : 0;
    if (!earlier && billed && billed.owed > 0 && paidSince >= billed.owed) {
      out.push({ feeId: fee.id, date: fee.date, amount: -fee.amount, why: 'first' });
    }
  }
  return out;
}
