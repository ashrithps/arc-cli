// Ported near-verbatim from the arc app (budgetarc utils/statementCycleLearning.ts, 1.0.50).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * A card's cycle, learned from the statements arc has seen (owner,
 * 2026-11-05: "the future dates should also be added based on cycles
 * automatically"): the statement day, how the due date follows it (a fixed
 * day of the month, or a fixed number of days after the statement), and what
 * the bank does when that lands on a weekend. Then the next 12 cycles,
 * projected. Pure.
 *
 * A real statement always beats a projection: learning reruns on every one.
 * Bank holidays aren't known here; a due date a holiday moved reads as noise
 * and the majority rule still wins.
 */

export interface ObservedCycle {
  /** Statement date, YYYY-MM-DD. */
  stmt: string;
  /** Payment due date, YYYY-MM-DD, when the statement printed one. */
  due?: string | null;
}

export type WeekendShift = 'next_business_day' | 'previous_business_day' | 'none';

export interface LearnedCycle {
  statementDay: number;
  /** How the due date is set: on a day of the month, or N days after the statement. */
  due: { kind: 'day'; day: number } | { kind: 'offset'; days: number } | null;
  weekend: WeekendShift;
  /** How many statements it was learned from. */
  from: number;
  /** Share of the statements the rules explain exactly, 0–1. */
  fit: number;
}

export interface ProjectedCycle {
  stmt: string;
  due: string | null;
  /** The due date before a weekend moved it. */
  dueBeforeShift?: string;
}

const parse = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => { const x = parse(d); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const daysBetween = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
const dow = (d: string) => parse(d).getUTCDay(); // 0 Sun … 6 Sat
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

/** The day `day` of the month of `ym` (YYYY-MM), clamped to the month's last day. */
export function dayInMonth(ym: string, day: number): string {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${pad(Math.min(day, daysInMonth(y, m)))}`;
}

function nextMonth(ym: string, n = 1): string {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

/** Move a date off a weekend the way the bank does. */
export function shiftWeekend(day: string, shift: WeekendShift): string {
  const w = dow(day);
  if (shift === 'none' || (w !== 0 && w !== 6)) return day;
  if (shift === 'next_business_day') return addDays(day, w === 6 ? 2 : 1);
  return addDays(day, w === 6 ? -1 : -2);
}

function mode(values: number[]): { value: number; count: number } | null {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: { value: number; count: number } | null = null;
  for (const [value, count] of counts) if (!best || count > best.count || (count === best.count && value < best.value)) best = { value, count };
  return best;
}

/** The due date a rule gives for a statement, before any weekend shift. */
function nominalDue(stmt: string, rule: NonNullable<LearnedCycle['due']>): string {
  if (rule.kind === 'offset') return addDays(stmt, rule.days);
  // The first such day after the statement.
  const sameMonth = dayInMonth(stmt.slice(0, 7), rule.day);
  return sameMonth > stmt ? sameMonth : dayInMonth(nextMonth(stmt.slice(0, 7)), rule.day);
}

/**
 * The fewest days a bank leaves between a statement and its due date (intel
 * §1): India, "at least one fortnight" before interest starts (RBI); the US,
 * delivered at least 21 days before the due date (Reg Z 1026.5(b)(2)); 10
 * elsewhere (an engineering choice). A read gap outside this, or over 60
 * days, is a misread date until shown otherwise: never learned from.
 */
export function minDueGap(currency?: string | null): number {
  if (currency === 'INR') return 14;
  if (currency === 'USD') return 21;
  return 10;
}
export const MAX_DUE_GAP = 60;

/** A statement whose due date is suspect by those bounds. */
export function dueGapSuspect(stmt: string, due: string, currency?: string | null): boolean {
  const gap = daysBetween(stmt, due);
  return gap < minDueGap(currency) || gap > MAX_DUE_GAP;
}

/**
 * Learn from at least two statements (one is a guess, not a pattern). The
 * statement day is the most common day; the due rule is whichever of "day of
 * the month" or "days after the statement" explains more due dates once a
 * weekend shift is allowed.
 */
export function learnCycle(observed: ObservedCycle[], opts: { currency?: string | null } = {}): LearnedCycle | null {
  // A statement whose due date breaks the bounds is a misread: left out whole (its statement date too).
  const stmts = observed
    .filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.stmt))
    .filter((o) => !(o.due && /^\d{4}-\d{2}-\d{2}$/.test(o.due) && dueGapSuspect(o.stmt, o.due, opts.currency)))
    .sort((a, b) => (a.stmt < b.stmt ? -1 : 1));
  if (stmts.length < 2) return null;
  const sd = mode(stmts.map((o) => +o.stmt.slice(8, 10)));
  if (!sd) return null;
  const withDue = stmts.filter((o) => o.due && /^\d{4}-\d{2}-\d{2}$/.test(o.due) && o.due > o.stmt) as Array<{ stmt: string; due: string }>;

  let best: { due: LearnedCycle['due']; weekend: WeekendShift; hits: number } = { due: null, weekend: 'none', hits: 0 };
  if (withDue.length) {
    const candidates: Array<NonNullable<LearnedCycle['due']>> = [];
    const offsets = mode(withDue.map((o) => daysBetween(o.stmt, o.due)));
    if (offsets) candidates.push({ kind: 'offset', days: offsets.value });
    // A weekend-moved due date isn't the rule's day: try the most common
    // day among those that fall on a weekday the bank didn't move.
    const days = mode(withDue.map((o) => +o.due.slice(8, 10)));
    if (days) candidates.push({ kind: 'day', day: days.value });
    for (const extra of withDue) {
      // The nominal day before a Monday shift / after a Friday shift, as a candidate too.
      const w = dow(extra.due);
      if (w === 1) candidates.push({ kind: 'day', day: +addDays(extra.due, -2).slice(8, 10) }, { kind: 'day', day: +addDays(extra.due, -1).slice(8, 10) });
      if (w === 5) candidates.push({ kind: 'day', day: +addDays(extra.due, 2).slice(8, 10) }, { kind: 'day', day: +addDays(extra.due, 1).slice(8, 10) });
    }
    for (const rule of candidates) {
      for (const weekend of ['none', 'next_business_day', 'previous_business_day'] as WeekendShift[]) {
        const hits = withDue.filter((o) => shiftWeekend(nominalDue(o.stmt, rule), weekend) === o.due).length;
        // Ties go to the simpler story: no shift, then the day of the month.
        if (hits > best.hits) best = { due: rule, weekend, hits };
      }
    }
  }
  const stmtHits = stmts.filter((o) => +o.stmt.slice(8, 10) === sd.value
    || (sd.value > daysInMonth(+o.stmt.slice(0, 4), +o.stmt.slice(5, 7)) && o.stmt === dayInMonth(o.stmt.slice(0, 7), sd.value))).length;
  const total = stmts.length + withDue.length;
  return {
    statementDay: sd.value,
    due: best.hits >= Math.max(1, Math.ceil(withDue.length / 2)) ? best.due : null,
    weekend: best.due ? best.weekend : 'none',
    from: stmts.length,
    fit: total ? (stmtHits + best.hits) / total : 0,
  };
}

/** The next `count` cycles after `after` (a date, usually the latest statement). */
export function projectCycles(learned: LearnedCycle, after: string, count = 12): ProjectedCycle[] {
  const out: ProjectedCycle[] = [];
  let ym = after.slice(0, 7);
  while (out.length < count) {
    const stmt = dayInMonth(ym, learned.statementDay);
    ym = nextMonth(ym);
    if (stmt <= after) continue;
    if (!learned.due) { out.push({ stmt, due: null }); continue; }
    const nominal = nominalDue(stmt, learned.due);
    const due = shiftWeekend(nominal, learned.weekend);
    out.push(due === nominal ? { stmt, due } : { stmt, due, dueBeforeShift: nominal });
  }
  return out;
}

/** The tag's due day for a learned rule: only a day-of-month rule maps onto `due:N`. */
export function tagDueDay(learned: LearnedCycle, projected: ProjectedCycle[]): number | null {
  if (learned.due?.kind === 'day') return learned.due.day;
  // A fixed offset lands on a different day each month: the tag takes the next one's.
  const next = projected.find((p) => p.due);
  return next?.due ? +((next.dueBeforeShift ?? next.due).slice(8, 10)) : null;
}

/**
 * Card details the statements taught, for the fields the user hasn't filled.
 * What the user typed always wins: a field that has a value is never changed,
 * and a due day the user declined (`ask:no`) is never filled.
 */
export function learnedTagUpdates(
  tag: { dueDay: number | null; statementDay: number | null; limit: number | null; askDeclined: boolean },
  learned: LearnedCycle,
  projected: ProjectedCycle[],
  latestLimit: number | null,
): { dueDay?: number; statementDay?: number; limit?: number } {
  const out: { dueDay?: number; statementDay?: number; limit?: number } = {};
  if (tag.statementDay == null) out.statementDay = learned.statementDay;
  const due = tagDueDay(learned, projected);
  if (tag.dueDay == null && !tag.askDeclined && due != null) out.dueDay = due;
  if (tag.limit == null && latestLimit != null && latestLimit > 0) out.limit = latestLimit;
  return out;
}

/** The learned rule in the record's short form ("d5", "o20"). */
export function dueCode(learned: LearnedCycle): string | undefined {
  if (!learned.due) return undefined;
  return learned.due.kind === 'day' ? `d${learned.due.day}` : `o${learned.due.days}`;
}
