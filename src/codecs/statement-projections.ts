// Ported near-verbatim from the arc app (budgetarc utils/statementProjections.ts, 1.0.50).
// A compatibility surface: keep it in step with the app, do not tidy it.
//
// Read side only: cycleFromRecord, projectedDates and missingStatement, verbatim.
// The filing-side learners (annualFeeFrom, loanEndFrom, learnDates) read rows off
// a statement PDF, which the CLI never does; their results arrive here already
// stored in the record's `dates`.
/**
 * The dates ahead, from what the statements taught (owner, 2026-11-05: "the
 * future dates should also be added based on cycles automatically… annual
 * fee, promo end and EMI end too"). Each kind is learned from a statement:
 *
 * - statement and due dates: the learned cycle (utils/statementCycleLearning);
 * - the annual fee: the month (and day) a card's membership fee was charged;
 * - a promotional rate's end: the date the statement prints;
 * - a loan's last EMI: from its schedule, the outstanding principal, the EMI
 *   and the rate the last instalment implies.
 *
 * A real statement beats a projection: projections start after the newest
 * statement filed. Reminders, the debt home and the Home glance read
 * `projectedDates`. Pure.
 */
import type { LearnedDates, LearnedRecord, StatementsRecord } from './statement-checkpoints.js';
import { dayInMonth, projectCycles, type LearnedCycle } from './statement-cycle-learning.js';

export type { LearnedDates };

/** The record's short form back into a cycle projectCycles can use. */
export function cycleFromRecord(learned: LearnedRecord): LearnedCycle {
  const m = /^([do])(\d{1,2})$/.exec(learned.due ?? '');
  return {
    statementDay: learned.stmtDay,
    due: m ? (m[1] === 'd' ? { kind: 'day', day: +m[2] } : { kind: 'offset', days: +m[2] }) : null,
    weekend: learned.weekend ?? 'none',
    from: 0,
    fit: 1,
  };
}

export type ProjectedKind = 'statement' | 'due' | 'annual_fee' | 'promo_end' | 'loan_end';

export interface ProjectedDate {
  kind: ProjectedKind;
  date: string;
}

/**
 * The account's dates ahead, in date order: the next `count` statement and
 * due dates, the next annual fee, a promo's end and a loan's last EMI. Starts
 * after the newer of `today` and the newest statement filed.
 */
export function projectedDates(record: StatementsRecord, today: string, count = 12): ProjectedDate[] {
  const newest = record.stmts[record.stmts.length - 1]?.end;
  const after = newest && newest > today ? newest : today;
  const out: ProjectedDate[] = [];
  if (record.learned) {
    for (const p of projectCycles(cycleFromRecord(record.learned), after, count)) {
      out.push({ kind: 'statement', date: p.stmt });
      if (p.due) out.push({ kind: 'due', date: p.due });
    }
  }
  const dates = record.dates;
  if (dates?.fee) {
    const y = +after.slice(0, 4);
    for (const year of [y, y + 1]) {
      const day = dayInMonth(`${year}-${String(dates.fee.m).padStart(2, '0')}`, dates.fee.d);
      if (day > after) { out.push({ kind: 'annual_fee', date: day }); break; }
    }
  }
  if (dates?.promoEnd && dates.promoEnd > today) out.push({ kind: 'promo_end', date: dates.promoEnd });
  if (dates?.loanEnd && dates.loanEnd > today) out.push({ kind: 'loan_end', date: dates.loanEnd });
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * A statement that should have arrived and hasn't (intel #6): the learned
 * statement date after the newest one filed, five days gone. The forward has
 * probably stopped (a changed mail filter, a new bank address). Not for an
 * account whose last statement closed at zero (many banks skip those).
 */
export function missingStatement(record: StatementsRecord, today: string, graceDays = 5): string | null {
  const newest = record.stmts[record.stmts.length - 1];
  if (!record.learned || !newest || newest.src !== 'import') return null;
  if (!newest.close) return null;
  const next = projectCycles(cycleFromRecord(record.learned), newest.end, 1)[0]?.stmt;
  if (!next) return null;
  const late = new Date(`${next}T00:00:00Z`);
  late.setUTCDate(late.getUTCDate() + graceDays);
  return today > late.toISOString().slice(0, 10) ? next : null;
}
