// Ported near-verbatim from the arc app (budgetarc utils/debtProgress.ts, 1.0.49).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * Progress on a debt, or on all of them, from the balance history arc already
 * has (docs/research/debt-2026-11.md §7.2, ideas 1–3): how much of the most
 * ever owed is paid off, what went down this month, and when it's gone at the
 * pace of the last three months. Pure; amounts in minor units, book currency.
 */
import { addDays, daysBetween } from './debt-cycle.js';

/** One day's net movement on the account(s), oldest first. */
export interface DailyNet {
  date: string;
  net: number;
}

export interface DebtProgress {
  /** Owed today (positive), 0 when nothing is. */
  owedNow: number;
  /** The most owed on any day arc has, never below owedNow. */
  peakOwed: number;
  /** 0–1 of the peak paid off. */
  paidOff: number;
  /** Owed on the 1st less owed now, when that's down; else 0. */
  downThisMonth: number;
  /** Paid down a month, on average over the last three; null unless it's going down. */
  monthlyPaydown: number | null;
  /** The month it reaches zero at that pace (YYYY-MM); null when it isn't going down. */
  debtFreeMonth: string | null;
}

const PACE_DAYS = 91;

/**
 * `days` are the account's (or accounts') daily nets, every one since the
 * first; owed is minus the running balance. Nothing owed before the first row.
 */
export function debtProgressOf(days: ReadonlyArray<DailyNet>, today: string): DebtProgress {
  const monthStart = `${today.slice(0, 7)}-01`;
  const paceFrom = addDays(today, -PACE_DAYS);
  let balance = 0;
  let peak = 0;
  let atMonthStart = 0;
  let atPaceFrom = 0;
  for (const day of days) {
    if (day.date > today) break;
    if (day.date < monthStart) atMonthStart = balance + day.net;
    if (day.date < paceFrom) atPaceFrom = balance + day.net;
    balance += day.net;
    peak = Math.max(peak, -balance);
  }
  const owedNow = Math.max(0, -balance);
  const owedMonthStart = Math.max(0, -atMonthStart);
  const owedPaceFrom = Math.max(0, -atPaceFrom);
  const peakOwed = Math.max(peak, owedNow);
  const paidOff = peakOwed > 0 ? Math.min(1, Math.max(0, (peakOwed - owedNow) / peakOwed)) : 0;

  const firstDay = days.find((d) => d.date <= today)?.date;
  // A pace needs the history to reach back to its start.
  const paceDays = firstDay ? Math.min(PACE_DAYS, daysBetween(firstDay, today)) : 0;
  const paidDown = owedPaceFrom - owedNow;
  const monthlyPaydown = paceDays >= 60 && paidDown > 0 && owedNow > 0
    ? Math.round((paidDown / PACE_DAYS) * 30.44)
    : null;
  let debtFreeMonth: string | null = null;
  if (monthlyPaydown && monthlyPaydown > 0) {
    const months = Math.ceil(owedNow / monthlyPaydown);
    if (months <= 600) {
      const [y, m] = today.split('-').map(Number);
      const target = new Date(y, m - 1 + months, 1, 12);
      debtFreeMonth = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
    }
  }
  return {
    owedNow,
    peakOwed,
    paidOff,
    downThisMonth: Math.max(0, owedMonthStart - owedNow),
    monthlyPaydown,
    debtFreeMonth,
  };
}

/** Nets of several accounts' days, merged by date. */
export function mergeDailyNets(lists: ReadonlyArray<ReadonlyArray<DailyNet>>): DailyNet[] {
  const byDay = new Map<string, number>();
  for (const list of lists) for (const d of list) byDay.set(d.date, (byDay.get(d.date) ?? 0) + d.net);
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, net]) => ({ date, net }));
}
