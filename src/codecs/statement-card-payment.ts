// Ported near-verbatim from the arc app (budgetarc utils/statementCardPayment.ts, 1.0.50).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * The card payment in Upcoming (decision §6.13): read-only, from the newest
 * statement filed and the cycle learned from its statements, with a one-tap
 * "Make it a schedule". arc never creates the schedule on its own.
 *
 * Everything is as of the statement's own dates: what's due is the
 * statement balance less what was paid into the card since, and a statement
 * paid off has nothing due.
 */
import type { StatementsRecord } from './statement-checkpoints.js';
import { cycleFromRecord } from './statement-projections.js';
import { projectCycles } from './statement-cycle-learning.js';

export interface CardPaymentDue {
  /** The statement it's for (its end date). */
  statement: string;
  /** When it's due, moved off a weekend the way the bank moves it. */
  due: string;
  /** What the statement asked for, in cents (positive). */
  owed: number;
  /** Still owed on it after payments since, in cents (positive). */
  left: number;
  /**
   * For a monthly schedule: the due date before any weekend move, and the
   * bank's move. A due date set N days after the statement drifts by a day or
   * two with the month's length; the schedule's amount and date are approximate.
   */
  schedule: { start: string; weekend: 'before' | 'after' | null };
  /**
   * The statement before wasn't paid in full by its due date, so interest
   * runs on new purchases too (the grace period is lost): its end date.
   * Null when it was, or arc can't tell.
   */
  graceLostFrom: string | null;
}

const dayAfter = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};

const dayBefore = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10);
};

/**
 * What's due on the newest statement, or null: no statement with a balance,
 * no learned due date, already paid, or the due date has passed.
 */
export function cardPaymentDue(
  record: StatementsRecord,
  today: string,
  paidSinceCents: number,
  /** Money into the card between two dates (cents), for the grace check; without it, not checked. */
  paidBetween?: (from: string, to: string) => number,
): CardPaymentDue | null {
  const latest = record.stmts[record.stmts.length - 1];
  if (!latest || latest.src !== 'import' || latest.close === undefined || !record.learned) return null;
  const owed = -latest.close; // a card's balance is stored negative
  if (owed <= 0) return null;
  const left = owed - Math.max(0, paidSinceCents);
  if (left <= 0) return null;
  const now = learnedDueFor(record, latest.end);
  if (!now || now.due < today) return null;
  const weekend = record.learned.weekend === 'next_business_day' ? 'after' : record.learned.weekend === 'previous_business_day' ? 'before' : null;
  // Interest-free only after a statement paid in full by its due date (+ the bank's 3 days in India is for fees, not interest).
  let graceLostFrom: string | null = null;
  const prev = record.stmts.length > 1 ? record.stmts[record.stmts.length - 2] : null;
  const prevDue = prev ? learnedDueFor(record, prev.end) : null;
  if (paidBetween && prev && prev.src === 'import' && prev.close !== undefined && -prev.close > 0 && prevDue && prevDue.due < latest.end) {
    if (paidBetween(dayAfter(prev.end), prevDue.due) < -prev.close) graceLostFrom = prev.end;
  }
  return { statement: latest.end, due: now.due, owed, left, schedule: { start: now.dueBeforeShift ?? now.due, weekend }, graceLostFrom };
}

/**
 * The due date the learned cycle gives the statement ending `end`, or null:
 * no learned due rule, or the statement doesn't fit the cycle (none within
 * 3 days of it; a bank can close a day early).
 */
export function learnedDueFor(record: StatementsRecord, end: string): { due: string; dueBeforeShift?: string } | null {
  if (!record.learned) return null;
  const learned = cycleFromRecord(record.learned);
  if (!learned.due) return null;
  const cycles = projectCycles(learned, dayBefore(dayBefore(dayBefore(dayBefore(end)))), 2);
  const gap = (c: { stmt: string }) => Math.abs(Date.parse(c.stmt) - Date.parse(end)) / 86_400_000;
  const near = cycles.filter((c) => gap(c) <= 3).sort((a, b) => gap(a) - gap(b))[0];
  return near?.due ? { due: near.due, ...(near.dueBeforeShift ? { dueBeforeShift: near.dueBeforeShift } : {}) } : null;
}
