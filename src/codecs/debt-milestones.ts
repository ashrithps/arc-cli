// Ported near-verbatim from the arc app (budgetarc utils/retention/debtMilestones.ts, 1.0.49).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * Debt milestones (docs/research/debt-2026-11.md §7.2 idea 9, §7.3), by the
 * goal milestones' rules (./milestones): each crossing celebrated once, only
 * the highest when several land together for one debt, and whatever a debt
 * had already reached when arc first sees it recorded silently.
 *
 *   debt:<id>:25 / 50 / 75 / 100   a loan or plan that far paid off
 *   debt:<id>:clear                a card that carried a balance, now clear
 *   debt:<id>:util30               the first statement under 30% after one over
 *   debt:<id>:year                 twelve cycles on time
 *   debt:all:free                  nothing owed anywhere, after a real debt
 *
 * A moment that needs facts arc may not have yet (the cycle history, a loan's
 * schedule) is judged only once this phone has them, and the first time it
 * does, what they show is recorded silently too. A second phone, or a tag
 * typed in later, never opens with "a year on time" earned months ago.
 *
 * Pure: services/retention/debtMilestonesRuntime supplies the facts.
 */
import type { DebtKind } from './debt-tag.js';

/** As the app's utils/retention/milestones.ts declares it. */
export interface MilestoneUpdate {
  /** Keys to record now without showing anything. */
  silent: string[];
  /** Keys to celebrate, each once. Recorded when shown or dismissed. */
  pending: string[];
}

export const DEBT_STEPS = [25, 50, 75, 100] as const;
export type DebtStep = (typeof DEBT_STEPS)[number];
export type DebtMoment = DebtStep | 'clear' | 'util30' | 'year';

export const debtSeenKey = (id: string) => `debt:${id}:seen`;
/** This phone has judged the debt with its cycle history / its schedule. */
export const debtHistorySeenKey = (id: string) => `debt:${id}:hist`;
export const debtScheduleSeenKey = (id: string) => `debt:${id}:sched`;
export const debtMomentKey = (id: string, moment: DebtMoment) => `debt:${id}:${moment}`;
export const DEBT_FREE_KEY = 'debt:all:free';

export function parseDebtMomentKey(key: string): { id: string; moment: DebtMoment } | null {
  if (key === DEBT_FREE_KEY) return null;
  const m = /^debt:(.+):(25|50|75|100|clear|util30|year)$/.exec(key);
  if (!m) return null;
  const moment = /^\d+$/.test(m[2]) ? (Number(m[2]) as DebtStep) : (m[2] as DebtMoment);
  return { id: m[1], moment };
}

export interface DebtForMilestones {
  id: string;
  kind: DebtKind;
  /** 0–1 paid off: the plan's or schedule's for a loan, else of the most owed. */
  paidOff: number;
  /** Owed now, minor units, never below 0. */
  owed: number;
  /** A card that carried a balance past a statement in the last year. */
  carried: boolean;
  /** Cycles on time, running. */
  onTime: number;
  /** Balance ÷ limit at the newest statement and the one before. */
  statementUtilisation: [number | null, number | null];
  /** The cycle history is in (a due day, and a cycle arc could judge). */
  hasHistory: boolean;
  /** `paidOff` comes from the loan's principal or the plan, not the balance history. */
  fromSchedule: boolean;
}

function stepsOf(debt: DebtForMilestones): DebtMoment[] {
  if (debt.kind === 'card') return [];
  return DEBT_STEPS.filter((step) => (step === 100 ? debt.owed === 0 && debt.paidOff > 0 : debt.paidOff * 100 >= step));
}

/** The moments read from the cycles: none until they're in. */
function historyMomentsOf(debt: DebtForMilestones): DebtMoment[] {
  if (!debt.hasHistory) return [];
  const out: DebtMoment[] = [];
  if (debt.kind === 'card') {
    if (debt.carried && debt.owed === 0) out.push('clear');
    const [now, before] = debt.statementUtilisation;
    if (now != null && before != null && now < 0.3 && before >= 0.3) out.push('util30');
  }
  if (debt.onTime >= 12) out.push('year');
  return out;
}

/**
 * CLI addition: every moment this debt has reached by the app's rules, without
 * the phone's once-only ledger (which lives on the phone and never syncs).
 */
export function debtMomentsReached(debt: DebtForMilestones): DebtMoment[] {
  return [...stepsOf(debt), ...historyMomentsOf(debt)];
}

/** Bigger news first: what's shown when several land at once. */
const RANK: Record<string, number> = { 25: 1, 50: 2, util30: 2, 75: 3, year: 3, 100: 5, clear: 5 };

export function debtMilestones(debts: ReadonlyArray<DebtForMilestones>, recorded: readonly string[]): MilestoneUpdate {
  const have = new Set(recorded);
  const silent: string[] = [];
  const pending: string[] = [];
  for (const debt of debts) {
    const keys = (moments: DebtMoment[]) => moments.map((m) => debtMomentKey(debt.id, m)).filter((k) => !have.has(k));
    const steps = keys(stepsOf(debt));
    const history = keys(historyMomentsOf(debt));
    if (!have.has(debtSeenKey(debt.id))) {
      silent.push(debtSeenKey(debt.id), ...steps, ...history);
      if (debt.hasHistory) silent.push(debtHistorySeenKey(debt.id));
      if (debt.fromSchedule) silent.push(debtScheduleSeenKey(debt.id));
      continue;
    }
    const fresh: string[] = [];
    // The first look with a schedule, or with the history: what they show was earned before.
    if (debt.fromSchedule && !have.has(debtScheduleSeenKey(debt.id))) silent.push(debtScheduleSeenKey(debt.id), ...steps);
    else fresh.push(...steps);
    if (debt.hasHistory && !have.has(debtHistorySeenKey(debt.id))) silent.push(debtHistorySeenKey(debt.id), ...history);
    else fresh.push(...history);
    if (fresh.length === 0) continue;
    const rank = (k: string) => RANK[String(parseDebtMomentKey(k)?.moment)] ?? 0;
    const top = fresh.reduce((a, b) => (rank(b) >= rank(a) ? b : a));
    silent.push(...fresh.filter((k) => k !== top));
    pending.push(top);
  }
  // Debt-free: every debt at zero, one of them a loan or a card that carried a
  // balance; a card paid in full each month going quiet is no news.
  const real = debts.some((d) => d.kind !== 'card' || d.carried);
  if (debts.length > 0 && real && debts.every((d) => d.owed === 0) && !have.has(DEBT_FREE_KEY)) {
    const seenAll = debts.every((d) => have.has(debtSeenKey(d.id)));
    if (seenAll) {
      // The whole is the news: the single debts' moments go with it.
      silent.push(...pending.splice(0));
      pending.push(DEBT_FREE_KEY);
    } else silent.push(DEBT_FREE_KEY);
  }
  return { silent, pending };
}
