// Ported near-verbatim from the arc app (budgetarc utils/debtPayoff.ts, 1.0.49).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * What paying a debt off takes (docs/research/debt-2026-11.md §6–§7): how long
 * the payment in hand takes and what it costs, what more each month or a
 * one-off would save, where a loan stands against its schedule, how much of an
 * instalment was interest, and which debt spare money clears first. Pure;
 * minor units, yearly % rates, interest charged monthly on what's owed (how
 * cards, loans and EMIs are quoted).
 */
import { isCardPayment } from './card-payment.js';
import { addDays, type DebtRow } from './debt-cycle.js';
import { debtChargeKind } from './debt-charges.js';
import type { DebtTag } from './debt-tag.js';

/** Fifty years: past this a payment is treated as never clearing it. */
export const MAX_MONTHS = 600;

const monthlyRate = (ratePct: number) => Math.max(0, ratePct) / 1200;

/** The instalment that clears `principal` in `months` at `ratePct`. */
export function instalmentFor(principal: number, ratePct: number, months: number): number {
  if (months <= 0 || principal <= 0) return 0;
  const r = monthlyRate(ratePct);
  if (r === 0) return Math.ceil(principal / months);
  return Math.ceil((principal * r) / (1 - Math.pow(1 + r, -months)));
}

export interface PayoffRun {
  /** Payments until nothing is owed, the last one part of a payment. */
  months: number;
  /** Interest charged on the way. */
  interest: number;
}

/** `payment` a month against `owed`; null when it never clears (it doesn't beat the interest). */
export function payoffRun(owed: number, ratePct: number, payment: number): PayoffRun | null {
  if (owed <= 0) return { months: 0, interest: 0 };
  const r = monthlyRate(ratePct);
  if (payment <= Math.round(owed * r)) return null;
  let balance = owed;
  let interest = 0;
  for (let month = 1; month <= MAX_MONTHS; month++) {
    const charge = Math.round(balance * r);
    balance += charge;
    interest += charge;
    if (balance <= payment) return { months: month, interest };
    balance -= payment;
  }
  return null;
}

export interface PayMore {
  now: PayoffRun;
  more: PayoffRun;
  monthsSooner: number;
  interestSaved: number;
}

/** `extra` on top of `payment` every month. Null when the payment alone never clears it. */
export function payMore(owed: number, ratePct: number, payment: number, extra: number): PayMore | null {
  const now = payoffRun(owed, ratePct, payment);
  const more = payoffRun(owed, ratePct, payment + Math.max(0, extra));
  if (!now || !more) return null;
  return { now, more, monthsSooner: now.months - more.months, interestSaved: now.interest - more.interest };
}

export interface Prepayment {
  now: PayoffRun;
  /** Keep the instalment: it ends sooner. */
  sooner: { months: number; monthsSooner: number; interestSaved: number };
  /** Keep the end: the instalment drops. */
  lower: { payment: number; paymentDrop: number; interestSaved: number };
}

/** `lump` paid once today, the two ways a lender re-sets a loan after it. */
export function prepay(owed: number, ratePct: number, payment: number, lump: number): Prepayment | null {
  const now = payoffRun(owed, ratePct, payment);
  if (!now || lump <= 0) return null;
  const left = Math.max(0, owed - lump);
  const sooner = payoffRun(left, ratePct, payment)!;
  const lowerPayment = instalmentFor(left, ratePct, now.months);
  const lower = payoffRun(left, ratePct, lowerPayment) ?? { months: 0, interest: 0 };
  return {
    now,
    sooner: { months: sooner.months, monthsSooner: now.months - sooner.months, interestSaved: now.interest - sooner.interest },
    lower: { payment: lowerPayment, paymentDrop: payment - lowerPayment, interestSaved: now.interest - lower.interest },
  };
}

/**
 * The month the last of `months` monthly payments falls in, the first on
 * `firstDue` (YYYY-MM-DD): one payment due this month is paid off this month.
 */
export function payoffMonth(firstDue: string, months: number): string {
  return monthAfter(firstDue, Math.max(0, months - 1));
}

/**
 * The day the next payment is due, for payoffMonth: this cycle's due date, or
 * next month's once this one is paid (YYYY-MM-DD, only the month matters).
 */
export function nextPaymentDay(dueDate: string | null | undefined, settled: boolean, today: string): string {
  if (!dueDate) return today;
  if (settled) return `${monthAfter(dueDate, 1)}-01`;
  return dueDate < today ? today : dueDate;
}

/** The month `months` after `today`'s (YYYY-MM). */
export function monthAfter(today: string, months: number): string {
  const [y, m] = today.split('-').map(Number);
  const target = new Date(y, m - 1 + months, 1, 12);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
}

/** What a loan or plan is paid each time: the tag's instalment, else its schedule's. */
export function loanPaymentOf(tag: DebtTag | null): number | null {
  if (!tag) return null;
  if (tag.emi && tag.emi > 0) return tag.emi;
  if (tag.principal && tag.rate != null && tag.term) return instalmentFor(tag.principal, tag.rate, tag.term);
  return null;
}

// ---------------------------------------------------------------------------
// A loan against its schedule
// ---------------------------------------------------------------------------

export interface LoanSchedulePoint {
  /** Instalments due by today. */
  due: number;
  term: number;
  /** What the schedule says is owed after them. */
  scheduledOwed: number;
  /** Interest the schedule charged so far. */
  interestSoFar: number;
}

/**
 * Where the schedule stands today: `start` is the first instalment month
 * (YYYY-MM), `dueDay` its day. Null without principal, rate, start and term.
 */
export function loanScheduleAt(
  loan: { principal: number | null; rate: number | null; emi: number | null; start: string | null; term: number | null; dueDay: number | null },
  today: string,
): LoanSchedulePoint | null {
  const { principal, rate, start, term } = loan;
  if (!principal || principal <= 0 || rate == null || !start || !term || term <= 0) return null;
  const emi = loan.emi && loan.emi > 0 ? loan.emi : instalmentFor(principal, rate, term);
  const [sy, sm] = start.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  let due = (ty - sy) * 12 + (tm - sm) + (td >= (loan.dueDay ?? 1) ? 1 : 0);
  due = Math.max(0, Math.min(term, due));
  const r = monthlyRate(rate);
  let owed = principal;
  let interestSoFar = 0;
  for (let k = 0; k < due; k++) {
    const charge = Math.round(owed * r);
    interestSoFar += charge;
    owed = Math.max(0, owed + charge - emi);
  }
  return { due, term, scheduledOwed: due >= term ? 0 : owed, interestSoFar };
}

// ---------------------------------------------------------------------------
// How much of an instalment was interest
// ---------------------------------------------------------------------------

export interface InstalmentSplit {
  /** The payment's day and amount, which also name it for "not now". */
  date: string;
  payment: number;
  interest: number;
  principal: number;
  key: string;
}

const SPLIT_LOOKBACK_DAYS = 40;
const INSTALMENT_TOLERANCE = 0.15;

/**
 * The newest instalment paid in the last 40 days, when nothing on the account
 * since the one before it says interest: about this much of it was interest,
 * the month's rate on what was owed before it. A suggestion the person
 * confirms (spec §8.11), never written by itself.
 */
export function instalmentSplit(
  rows: ReadonlyArray<DebtRow>,
  balance: number,
  ratePct: number | null,
  today: string,
  isInterest: (row: DebtRow) => boolean = (row) => debtChargeKind(row.text) === 'interest',
  /** The loan's instalment: a payment far from it (a prepayment) is no instalment to split. */
  instalment: number | null = null,
): InstalmentSplit | null {
  if (ratePct == null || ratePct <= 0) return null;
  const payments = rows.filter((r) => isCardPayment(r)).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const latest = payments[0];
  if (!latest || latest.date < addDays(today, -SPLIT_LOOKBACK_DAYS) || latest.date > today) return null;
  if (instalment && instalment > 0 && Math.abs(latest.amount - instalment) > instalment * INSTALMENT_TOLERANCE) return null;
  const before = payments.find((p) => p.date < latest.date)?.date ?? addDays(latest.date, -SPLIT_LOOKBACK_DAYS);
  const charged = rows.some((r) => r.amount < 0 && r.date >= before && r.date <= addDays(latest.date, 5) && isInterest(r));
  if (charged) return null;
  const since = rows.reduce((sum, r) => (r.date >= latest.date ? sum + r.amount : sum), 0);
  const owedBefore = -(balance - since);
  const interest = Math.round(owedBefore * monthlyRate(ratePct));
  if (interest <= 0 || interest >= latest.amount) return null;
  return {
    date: latest.date,
    payment: latest.amount,
    interest,
    principal: latest.amount - interest,
    key: `${latest.date}:${latest.amount}`,
  };
}

// ---------------------------------------------------------------------------
// Which debt first: avalanche (the highest rate) or snowball (the smallest)
// ---------------------------------------------------------------------------

export type PlanMethod = 'avalanche' | 'snowball';

export interface PlanDebt {
  id: string;
  owed: number;
  /** Null when not entered: counted as no interest, and avalanche can't rank it. */
  ratePct: number | null;
  /** Paid every month while anything is owed. */
  minimum: number;
}

export interface PayoffPlan {
  method: PlanMethod;
  /** The debt spare money goes to first. */
  first: string;
  /** In the order they're cleared. */
  order: string[];
  months: number;
  interest: number;
}

/**
 * Every minimum paid each month, plus `extra`, and what a cleared debt was
 * paying rolls on to the next. Null when they never clear.
 */
export function payoffPlan(debts: ReadonlyArray<PlanDebt>, method: PlanMethod, extra = 0): PayoffPlan | null {
  const live = debts.filter((d) => d.owed > 0);
  if (live.length === 0) return null;
  const ranked = [...live].sort((a, b) => (method === 'avalanche'
    ? (b.ratePct ?? 0) - (a.ratePct ?? 0) || a.owed - b.owed
    : a.owed - b.owed || (b.ratePct ?? 0) - (a.ratePct ?? 0)));
  const budget = live.reduce((sum, d) => sum + Math.max(0, d.minimum), 0) + Math.max(0, extra);
  const owed = new Map(ranked.map((d) => [d.id, d.owed]));
  const order: string[] = [];
  let interest = 0;
  for (let month = 1; month <= MAX_MONTHS; month++) {
    let charged = 0;
    for (const d of ranked) {
      const left = owed.get(d.id)!;
      if (left <= 0) continue;
      const charge = Math.round(left * monthlyRate(d.ratePct ?? 0));
      owed.set(d.id, left + charge);
      charged += charge;
    }
    interest += charged;
    if (month === 1 && budget <= charged) return null;
    let spare = budget;
    // Minimums first, then everything left in rank order.
    for (const d of ranked) {
      const left = owed.get(d.id)!;
      if (left <= 0) continue;
      const pay = Math.min(left, Math.max(0, d.minimum), spare);
      owed.set(d.id, left - pay);
      spare -= pay;
    }
    for (const d of ranked) {
      if (spare <= 0) break;
      const left = owed.get(d.id)!;
      if (left <= 0) continue;
      const pay = Math.min(left, spare);
      owed.set(d.id, left - pay);
      spare -= pay;
    }
    for (const d of ranked) if (owed.get(d.id)! <= 0 && !order.includes(d.id)) order.push(d.id);
    if (order.length === ranked.length) {
      return { method, first: ranked[0].id, order, months: month, interest };
    }
  }
  return null;
}

/** A minimum when none is known: the month's interest and 1% of what's owed (the usual card formula). */
export function estimatedMinimum(owed: number, ratePct: number | null): number {
  if (owed <= 0) return 0;
  return Math.min(owed, Math.round(owed * monthlyRate(ratePct ?? 0) + owed * 0.01));
}

/** A round amount near `minor` (major units of one or two figures), for "pay more" chips. */
export function roundAmount(minor: number): number {
  const major = minor / 100;
  if (major <= 1) return 100;
  const scale = Math.pow(10, Math.floor(Math.log10(major)));
  const step = major / scale >= 2.5 ? scale : scale / 2;
  return Math.max(100, Math.round(major / step) * step * 100);
}
