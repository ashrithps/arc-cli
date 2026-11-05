// Ported near-verbatim from the arc app (budgetarc services/creditCardReminders.utils.ts, 1.0.49).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * Pure helpers for credit-card reminder scheduling. No React Native imports
 * so the module can be unit-tested with plain Jest.
 */

/**
 * d3/d1/over: before and after the due date; stmt: the statement is out;
 * follow: still unpaid as the late-report day nears; promo30/promo7: a 0% period
 * ends; util: near the limit before the statement (opt-in); ap: autopay not seen.
 */
export type ReminderOffset = 'd3' | 'd1' | 'over' | 'stmt' | 'follow' | 'promo30' | 'promo7' | 'util' | 'ap';

export interface ReminderTrigger {
  offset: ReminderOffset;
  fireAt: Date;
  dueDate: Date;
  yyyymm: string; // "202604"
}

const REMINDER_HOUR_LOCAL = 9;

/**
 * Clamp a requested day-of-month to the last day that actually exists in
 * the given month. Handles `dueDay=31` in February and 30-day months.
 */
export function clampDueDay(year: number, monthIndex: number, dueDay: number): number {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return Math.min(Math.max(dueDay, 1), lastDay);
}

/**
 * Build a Date at 09:00 local time for the given year/monthIndex/day.
 * Uses the local timezone because `new Date(y, m, d, h)` is local-time.
 */
export function buildLocalDate(year: number, monthIndex: number, day: number): Date {
  return new Date(year, monthIndex, day, REMINDER_HOUR_LOCAL, 0, 0, 0);
}

/**
 * Compute the upcoming due date for a given dueDay. If today is past the
 * clamped due-day of the current month, roll forward to next month.
 */
export function computeUpcomingDueDate(dueDay: number, now: Date = new Date()): Date {
  const y = now.getFullYear();
  const m = now.getMonth();
  const todayClamped = clampDueDay(y, m, dueDay);
  const thisMonthDue = buildLocalDate(y, m, todayClamped);

  if (thisMonthDue.getTime() + 24 * 60 * 60 * 1000 > now.getTime()) {
    return thisMonthDue;
  }

  const nextMonth = m === 11 ? 0 : m + 1;
  const nextYear = m === 11 ? y + 1 : y;
  const nextClamped = clampDueDay(nextYear, nextMonth, dueDay);
  return buildLocalDate(nextYear, nextMonth, nextClamped);
}

/**
 * Compute the three trigger dates (3 days before, 1 day before, 1 day after)
 * for the upcoming due date. Past triggers are omitted — the caller shouldn't
 * schedule a notification for a moment that has already passed.
 */
export function computeTriggerDates(
  dueDay: number,
  now: Date = new Date(),
): ReminderTrigger[] {
  if (dueDay < 1 || dueDay > 31) return [];
  return triggersForDueDate(computeUpcomingDueDate(dueDay, now), now);
}

/** The three triggers for one due date, those still ahead of `now`. */
export function triggersForDueDate(dueDate: Date, now: Date = new Date()): ReminderTrigger[] {
  const yyyymm = formatYYYYMM(dueDate);

  const triggers: ReminderTrigger[] = [];
  const threeDayBefore = addDays(dueDate, -3);
  const oneDayBefore = addDays(dueDate, -1);
  const overdue = addDays(dueDate, 1);

  if (threeDayBefore.getTime() > now.getTime()) {
    triggers.push({ offset: 'd3', fireAt: threeDayBefore, dueDate, yyyymm });
  }
  if (oneDayBefore.getTime() > now.getTime()) {
    triggers.push({ offset: 'd1', fireAt: oneDayBefore, dueDate, yyyymm });
  }
  if (overdue.getTime() > now.getTime()) {
    triggers.push({ offset: 'over', fireAt: overdue, dueDate, yyyymm });
  }

  return triggers;
}

/** The due date one month after `dueDate`, at 09:00 local, clamped like the rest. */
export function followingDueDate(dueDay: number, dueDate: Date): Date {
  return dueDateInMonth(dueDate.getFullYear(), dueDate.getMonth() + 1, dueDay);
}

function dueDateInMonth(year: number, monthIndex: number, dueDay: number): Date {
  const first = new Date(year, monthIndex, 1);
  const y = first.getFullYear();
  const m = first.getMonth();
  return buildLocalDate(y, m, clampDueDay(y, m, dueDay));
}

function addDays(date: Date, days: number): Date {
  const clone = new Date(date.getTime());
  clone.setDate(clone.getDate() + days);
  return clone;
}

function formatYYYYMM(date: Date): string {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  return `${y}${m}`;
}

/**
 * Build a stable notification identifier. Idempotent so reconciles replace
 * rather than duplicate.
 */
export function buildReminderId(accountId: string, yyyymm: string, offset: ReminderOffset): string {
  return `cc-reminder-${accountId}-${yyyymm}-${offset}`;
}

export const REMINDER_ID_PREFIX = 'cc-reminder-';

/**
 * How many days up to and including a due day a payment counts toward it. The
 * statement comes out 14 to 25 days before the due day almost everywhere (US at
 * least 21, India 15 to 20, UK and Australia about 25), so paying once the
 * statement is out lands in these days: paid on 30 Oct for 2 Nov counts, which
 * a window from the 1st of the due month missed. Bounded by the previous due
 * day too, so last cycle's payment, even one a few days late, never settles
 * this one. A statement day on the debt tag would make this exact.
 */
export const PAYMENT_WINDOW_DAYS = 25;

/** Local calendar days, both ends included, as transaction dates are written. */
export interface PaymentWindow {
  startDay: string;
  endDay: string;
}

export function paymentWindowFor(dueDay: number, dueDate: Date): PaymentWindow {
  const dayAfterPrevious = addDays(dueDateInMonth(dueDate.getFullYear(), dueDate.getMonth() - 1, dueDay), 1);
  const lookback = addDays(dueDate, -(PAYMENT_WINDOW_DAYS - 1));
  const start = lookback.getTime() > dayAfterPrevious.getTime() ? lookback : dayAfterPrevious;
  return { startDay: localDay(start), endDay: localDay(dueDate) };
}

/** Money onto the card (amount > 0), as the reconciler reads it. */
export interface CardCredit {
  /** Minor units of the account. Charges are negative, payments positive. */
  amount: number;
  date: string;
  /** The other side is an account in this budget: a payment from the bank. */
  transfer: boolean;
  /** The category's kind: true income, false spending, null uncategorised. */
  categoryIsIncome: boolean | null;
  /** Payee, imported payee and notes, for the words a refund comes with. */
  text: string;
}

// Credits that put a purchase back rather than pay the card. Latin scripts as
// words; Japanese and Chinese have no word breaks.
const REFUND_WORDS = /\b(refund(ed)?|reversal|reversed|cash ?back|rewards?|charge ?back|returned|merchant credit|remboursement|r(ü|ue)ckerstattung|erstattung|r(ü|ue)ckbuchung|storno|reembolso|devoluci(ó|o)n|devolu(çã|ca)o|estorno|rimborso|terugbetaling|terugboeking|restitutie)\b/i;
const REFUND_CJK = /返金|払い戻し|払戻|キャッシュバック|退款|退货|退貨|返现|返現|冲正/;

/**
 * A credit that pays the card. A transfer from another account always does.
 * Otherwise a refund or cashback is not a payment: said so in its text, or
 * filed under a spending category, where Actual puts a refund back. What is
 * left (a payment typed in, or imported from the bank as "PAYMENT RECEIVED")
 * counts.
 */
export function isCardPayment(credit: CardCredit): boolean {
  if (!(credit.amount > 0)) return false;
  if (credit.transfer) return true;
  if (REFUND_WORDS.test(credit.text) || REFUND_CJK.test(credit.text)) return false;
  return credit.categoryIsIncome !== false;
}

export type CyclePaymentState = 'paid' | 'partial' | 'unpaid';

/**
 * Whether the card is paid for the due date `window` ends on. With the amount
 * due (minor units, the statement balance or the minimum), payments short of
 * it are partial; without it, which is every card today, any payment in the
 * window is taken as paid.
 */
export function cyclePaymentState(
  credits: ReadonlyArray<CardCredit>,
  window: PaymentWindow,
  amountDue: number | null = null,
): CyclePaymentState {
  let paid = 0;
  for (const credit of credits) {
    const day = typeof credit.date === 'string' ? credit.date.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (day < window.startDay || day > window.endDay) continue;
    if (isCardPayment(credit)) paid += credit.amount;
  }
  if (paid <= 0) return 'unpaid';
  if (amountDue != null && amountDue > 0 && paid < amountDue) return 'partial';
  return 'paid';
}

function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
