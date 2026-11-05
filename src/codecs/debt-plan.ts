// Ported near-verbatim from the arc app (budgetarc utils/debtPlan.ts, 1.0.49).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * The debts as a payoff plan (utils/debtPayoff payoffPlan), from the debt
 * home's summaries: what each pays a month, and the one debt-free month the
 * screens say (docs/specs/debt-cycle.md §7). Book currency, minor units.
 */
import type { DebtSummary } from './debt-summary.js';
import type { DebtProgress } from './debt-progress.js';
import type { DebtTag } from './debt-tag.js';
import { estimatedMinimum, loanPaymentOf, nextPaymentDay, payoffMonth, payoffPlan, type PlanDebt } from './debt-payoff.js';
import { bookToCard, knownFx } from './debt-money.js';

export interface PlanInput {
  id: string;
  summary: DebtSummary;
}

function ruleMinimum(tag: DebtTag | null, owed: number): number | null {
  if (!tag?.min) return null;
  if (tag.min.kind === 'all') return owed;
  return Math.min(owed, Math.max(Math.round((owed * tag.min.percent) / 100), tag.min.floor ?? 0));
}

/** What each debt pays a month, in the budget's currency: the known minimum or instalment, else an estimate. */
export function planDebtOf(debt: PlanInput): PlanDebt & { estimated: boolean } {
  const { summary } = debt;
  // The card's minimum or instalment is in its own currency: into the
  // budget's at its rate. Without one it can't be compared, so it's estimated.
  const fx = knownFx(summary.fxRate);
  const owed = summary.owedBook;
  const owedCard = bookToCard(owed, summary.fxRate);
  const rate = summary.tag?.rate ?? null;
  const known = summary.kind === 'card'
    ? summary.state?.minimum ?? (owedCard != null ? ruleMinimum(summary.tag, owedCard) : null)
    : loanPaymentOf(summary.tag);
  const knownBook = known != null && known > 0 && fx != null ? Math.round(known / fx) : null;
  const minimum = knownBook ?? estimatedMinimum(owed, rate);
  return { id: debt.id, owed, ratePct: rate, minimum: Math.min(owed, minimum), estimated: knownBook == null };
}

/** The next payment day among the debts, from `today`: the plan's first month. */
export function firstDueOf(summaries: ReadonlyArray<DebtSummary>, today: string): string {
  const days = summaries
    .filter((s) => s.owedBook > 0 && s.state?.dueDate)
    .map((s) => nextPaymentDay(s.state!.dueDate, s.state!.state === 'paid' || s.state!.state === 'nothing_due', today))
    .sort();
  return days[0] ?? today;
}

export interface DebtFree {
  /** YYYY-MM. */
  month: string;
  /** Paying every minimum (the plan), or the last three months' pace. */
  by: 'minimums' | 'pace';
}

/**
 * The one debt-free month the debt home and Home say. Said only while debt is
 * going down (owner, §8.18); then the plan's month, paying every minimum,
 * when it can be worked out, so "Pay here first" and the hero never give two
 * different months; else the pace's.
 */
export function debtFreeOf(summaries: ReadonlyArray<DebtSummary>, pace: DebtProgress | null, today: string): DebtFree | null {
  if (!pace?.debtFreeMonth) return null;
  const live = summaries.map((s) => planDebtOf({ id: s.accountId, summary: s })).filter((d) => d.owed > 0);
  if (live.length > 0) {
    const plan = payoffPlan(live, live.every((d) => d.ratePct != null) ? 'avalanche' : 'snowball');
    if (plan) return { month: payoffMonth(firstDueOf(summaries, today), plan.months), by: 'minimums' };
  }
  return { month: pace.debtFreeMonth, by: 'pace' };
}
