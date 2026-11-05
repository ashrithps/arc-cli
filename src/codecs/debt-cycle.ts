// Ported near-verbatim from the arc app (budgetarc utils/debtCycle.ts, 1.0.49).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * A debt's cycle and its state: the one place arc decides whether a card,
 * loan or BNPL plan is paid (docs/specs/debt-cycle.md §2–§3). The Accounts
 * badge, the reminders, the debt home, the card detail, streaks and the CLI
 * all call `debtCycleState` / `debtCycleHistory`; none keeps a rule of its own.
 *
 * Pure: the caller (DebtCycleService) reads the tag, the cycle records and the
 * account's rows; this works out the rest from local calendar days.
 */
import {
  type CardCredit,
  clampDueDay,
  computeUpcomingDueDate,
  isCardPayment,
  paymentWindowFor,
} from './card-payment.js';
import type { DebtTag } from './debt-tag.js';

// ---------------------------------------------------------------------------
// Cycle records (`arc-debt-cycles:<accountId>`)
// ---------------------------------------------------------------------------

export const DEBT_CYCLES_NOTE_PREFIX = 'arc-debt-cycles:';
export const debtCyclesNoteId = (accountId: string) => `${DEBT_CYCLES_NOTE_PREFIX}${accountId}`;
export const MAX_CYCLE_RECORDS = 13;

export type CycleSource = 'typed' | 'import' | 'capture';
/** Amounts a record can hold: ×100 integers in the card's currency, as Actual keeps every amount. */
export type CycleAmount = 'bal' | 'min' | 'limit' | 'avail' | 'prev' | 'int' | 'fees' | 'out' | 'princ' | 'intpd';
export type CycleField = 'stmt' | CycleAmount | 'marked';
const CYCLE_AMOUNTS: CycleAmount[] = ['bal', 'min', 'limit', 'avail', 'prev', 'int', 'fees', 'out', 'princ', 'intpd'];
const CYCLE_FIELDS: CycleField[] = ['stmt', ...CYCLE_AMOUNTS, 'marked'];
const SOURCE_RANK: Record<CycleSource, number> = { capture: 0, import: 1, typed: 2 };

export interface DebtCycleRecord {
  /** The due date the figures are for: the record's key. */
  due: string;
  stmt?: string;
  /**
   * Statement balance, in the card's currency as Actual keeps amounts: ×100
   * whatever the currency's own decimals (¥500 is 50000).
   */
  bal?: number;
  min?: number;
  limit?: number;
  avail?: number;
  /** The previous statement's balance. */
  prev?: number;
  /** Interest charged this cycle, and fees with their tax. */
  int?: number;
  fees?: number;
  /** A loan: outstanding after the instalment, and the instalment's principal and interest. */
  out?: number;
  princ?: number;
  intpd?: number;
  marked?: 'paid';
  src?: Partial<Record<CycleField, CycleSource>>;
  /** When the record last changed, epoch ms. */
  at: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isSource = (v: unknown): v is CycleSource => v === 'typed' || v === 'import' || v === 'capture';

/** The records in a note; anything malformed is left out. */
export function parseDebtCycles(raw: string | null | undefined): DebtCycleRecord[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { cycles?: unknown })?.cycles;
  if (!Array.isArray(list)) return [];
  const out: DebtCycleRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.due !== 'string' || !DAY.test(r.due)) continue;
    const record: DebtCycleRecord = { due: r.due, at: typeof r.at === 'number' ? r.at : 0 };
    if (typeof r.stmt === 'string' && DAY.test(r.stmt)) record.stmt = r.stmt;
    for (const key of CYCLE_AMOUNTS) {
      if (isAmount(r[key])) record[key] = Math.round(r[key] as number);
    }
    if (r.marked === 'paid') record.marked = 'paid';
    if (r.src && typeof r.src === 'object') {
      const src: Partial<Record<CycleField, CycleSource>> = {};
      for (const field of CYCLE_FIELDS) {
        const value = (r.src as Record<string, unknown>)[field];
        if (isSource(value) && record[field] !== undefined) src[field] = value;
      }
      if (Object.keys(src).length > 0) record.src = src;
    }
    out.push(record);
  }
  return out.sort((a, b) => (a.due < b.due ? 1 : a.due > b.due ? -1 : 0));
}

/**
 * The newest available limit a message printed on a card arc can't file under
 * a cycle yet (no due day): kept beside the cycles, never as one (spec §2).
 */
export interface LatestLimit {
  avail: number;
  /** The row's day (YYYY-MM-DD), and when it was kept. */
  day: string;
  at: number;
  src: CycleSource;
}

export function parseLatestLimit(raw: string | null | undefined): LatestLimit | null {
  if (!raw) return null;
  try {
    const l = (JSON.parse(raw) as { latest?: Record<string, unknown> })?.latest;
    if (!l || !isAmount(l.avail) || typeof l.day !== 'string' || !DAY.test(l.day) || !isSource(l.src)) return null;
    return { avail: Math.round(l.avail), day: l.day, at: typeof l.at === 'number' ? l.at : 0, src: l.src };
  } catch {
    return null;
  }
}

export function encodeDebtCycles(cycles: DebtCycleRecord[], latest: LatestLimit | null = null): string | null {
  if (cycles.length === 0 && !latest) return null;
  return JSON.stringify(latest ? { v: 1, cycles, latest } : { v: 1, cycles });
}

/** New figures for one due date; `marked: null` takes a "paid" mark back. */
export type CycleUpdate = Partial<Pick<DebtCycleRecord, Exclude<CycleField, 'marked'>>> & { due: string; marked?: 'paid' | null };

/**
 * Merge new figures into the records (spec §2): field by field, typed beats
 * import beats capture, and within one source the newer wins. `marked: null`
 * in a typed update takes a "paid" mark back. Keeps the newest 13.
 */
export function mergeDebtCycle(
  cycles: DebtCycleRecord[],
  update: CycleUpdate,
  source: CycleSource,
  at: number,
): DebtCycleRecord[] {
  const existing = cycles.find((c) => c.due === update.due);
  const next: DebtCycleRecord = existing ? { ...existing, src: { ...existing.src } } : { due: update.due, at, src: {} };
  let changed = !existing;
  for (const field of CYCLE_FIELDS) {
    if (!(field in update)) continue;
    const value = (update as Record<string, unknown>)[field];
    const held = existing?.src?.[field];
    if (held && SOURCE_RANK[held] > SOURCE_RANK[source]) continue;
    if (value === null || value === undefined) {
      if (field === 'marked' && next.marked !== undefined && source === 'typed') {
        delete next.marked;
        delete next.src![field];
        changed = true;
      }
      continue;
    }
    if (field === 'stmt' ? !(typeof value === 'string' && DAY.test(value)) : field === 'marked' ? value !== 'paid' : !isAmount(value)) continue;
    const normalized = typeof value === 'number' ? Math.round(value) : value;
    if ((next as unknown as Record<string, unknown>)[field] === normalized && held === source) continue;
    (next as unknown as Record<string, unknown>)[field] = normalized;
    next.src![field] = source;
    changed = true;
  }
  if (!changed) return cycles;
  next.at = at;
  if (next.src && Object.keys(next.src).length === 0) delete next.src;
  const rest = cycles.filter((c) => c.due !== update.due);
  return [next, ...rest].sort((a, b) => (a.due < b.due ? 1 : a.due > b.due ? -1 : 0)).slice(0, MAX_CYCLE_RECORDS);
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** A local day at noon, so a DST change never moves it to the next or last day. */
export function dayAt(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

export function addDays(day: string, n: number): string {
  const date = dayAt(day);
  date.setDate(date.getDate() + n);
  return localDay(date);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((dayAt(b).getTime() - dayAt(a).getTime()) / 86_400_000);
}

function dayInMonth(year: number, monthIndex: number, day: number): string {
  const first = new Date(year, monthIndex, 1, 12);
  return localDay(new Date(first.getFullYear(), first.getMonth(), clampDueDay(first.getFullYear(), first.getMonth(), day), 12));
}

function monthShift(day: string, months: number, dayOfMonth: number): string {
  const date = dayAt(day);
  return dayInMonth(date.getFullYear(), date.getMonth() + months, dayOfMonth);
}

/** The first `dayOfMonth` strictly after `day`. */
export function dayOfMonthAfter(day: string, dayOfMonth: number): string {
  const same = monthShift(day, 0, dayOfMonth);
  return same > day ? same : monthShift(day, 1, dayOfMonth);
}

/** The latest `stmtDay` strictly before `due` (spec §3.2). */
export function statementDateFor(stmtDay: number, due: string): string {
  const same = monthShift(due, 0, stmtDay);
  return same < due ? same : monthShift(due, -1, stmtDay);
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

const REPORTING_DAYS: Record<string, number> = { IN: 3, US: 30, CA: 30, AU: 14, NZ: 14, GB: 30 };

/** Days past due before a lender may report it (spec §3.4); null when arc doesn't know. */
export function reportingDaysFor(region: string | null | undefined): number | null {
  if (!region) return null;
  return REPORTING_DAYS[region.toUpperCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Due dates
// ---------------------------------------------------------------------------

const BNPL_STEP_DAYS: Record<'1w' | '2w', number> = { '1w': 7, '2w': 14 };

/** A plan's instalment days, oldest first. */
export function bnplDates(tag: DebtTag): string[] {
  if (!tag.first || !tag.instalments || !tag.every) return [];
  const out: string[] = [];
  for (let k = 0; k < Math.min(tag.instalments, 120); k++) {
    out.push(tag.every === '1m'
      ? monthShift(tag.first, k, dayAt(tag.first).getDate())
      : addDays(tag.first, k * BNPL_STEP_DAYS[tag.every]));
  }
  return out;
}

/**
 * The due date being looked at: this month's due day until the day after it
 * (the overdue reminder's morning), then next month's; for BNPL the next
 * instalment by the same rule. Null without a due day or after the last
 * instalment.
 */
export function upcomingDueDate(tag: DebtTag, today: Date): string | null {
  if (tag.kind === 'bnpl') {
    const todayDay = localDay(today);
    return bnplDates(tag).find((d) => addDays(d, 1) >= todayDay) ?? null;
  }
  if (tag.dueDay == null) return null;
  return localDay(computeUpcomingDueDate(tag.dueDay, today));
}

export function previousDueDate(tag: DebtTag, due: string): string | null {
  if (tag.kind === 'bnpl') {
    const dates = bnplDates(tag);
    const i = dates.indexOf(due);
    return i > 0 ? dates[i - 1] : null;
  }
  if (tag.dueDay == null) return null;
  return monthShift(due, -1, tag.dueDay);
}

export interface DebtWindow {
  startDay: string;
  endDay: string;
}

/** The days a payment counts toward `due` (spec §3.2). */
export function cycleWindow(tag: DebtTag, due: string): DebtWindow {
  if (tag.kind === 'card') {
    if (tag.statementDay != null) return { startDay: addDays(statementDateFor(tag.statementDay, due), 1), endDay: due };
    if (tag.dueDay != null) return paymentWindowFor(tag.dueDay, dayAt(due));
  }
  const prev = previousDueDate(tag, due);
  return { startDay: prev ? addDays(prev, 1) : addDays(due, -30), endDay: due };
}

// ---------------------------------------------------------------------------
// One cycle
// ---------------------------------------------------------------------------

export interface DebtRow extends CardCredit {
  /** The figure in the card's currency (minor units, the sign of `amount`), when the row's note says it. */
  native?: number | null;
  categoryId?: string | null;
}

export interface DebtCycleInput {
  tag: DebtTag;
  cycles: DebtCycleRecord[];
  /** The account's balance now, signed, book currency. */
  balance: number;
  /** The account's live rows, newest included, at least 13 months back. */
  rows: DebtRow[];
  /**
   * Card currency per book unit for a row without `native`: 1 when the card is
   * in the budget's currency, null when the card's currency can't be reached.
   */
  fxRate: number | null;
}

export type DebtCycleStatus = 'nothing_due' | 'autopay' | 'paid' | 'part_paid' | 'unpaid' | 'overdue';

export interface DebtCycleState {
  kind: DebtTag['kind'];
  dueDate: string | null;
  statementDate: string | null;
  window: DebtWindow | null;
  amountDue: number | null;
  amountDueSource: 'statement' | 'derived' | 'instalment' | null;
  minimum: number | null;
  paid: number;
  left: number | null;
  state: DebtCycleStatus;
  daysUntilDue: number | null;
  daysPastDue: number;
  reportingDays: number | null;
  /** The cycle just gone that still isn't paid (its minimum, when known), for the follow-up and a hard month. */
  missed: { dueDate: string; daysPastDue: number; minimum: number | null; left: number | null } | null;
}

interface Evaluation {
  amountDue: number | null;
  source: DebtCycleState['amountDueSource'];
  minimum: number | null;
  paid: number;
  payments: DebtRow[];
  state: 'nothing_due' | 'paid' | 'part_paid' | 'unpaid';
  window: DebtWindow;
  statementDate: string | null;
}

/** The row in the card's currency, or null when it can't be had. */
function inCard(row: DebtRow, fxRate: number | null): number | null {
  if (row.native != null && Number.isFinite(row.native)) return row.native;
  if (fxRate == null) return null;
  return Math.round(row.amount * fxRate);
}

function minimumOf(tag: DebtTag, amountDue: number | null, record: DebtCycleRecord | undefined): number | null {
  if (record?.min != null) return record.min;
  if (amountDue == null || !tag.min) return null;
  if (tag.min.kind === 'all') return amountDue;
  const pct = Math.round((amountDue * tag.min.percent) / 100);
  return Math.min(amountDue, Math.max(pct, tag.min.floor ?? 0));
}

function evaluate(
  input: DebtCycleInput,
  due: string,
  windowEnd: string,
  exclude: ReadonlySet<DebtRow>,
): Evaluation {
  const { tag, rows, fxRate } = input;
  const record = input.cycles.find((c) => c.due === due);
  const window = cycleWindow(tag, due);
  const statementDate = tag.kind === 'card' && tag.statementDay != null
    ? (record?.stmt ?? statementDateFor(tag.statementDay, due))
    : (record?.stmt ?? null);

  let convertible = true;
  const payments = rows
    .filter((r) => r.date >= window.startDay && r.date <= windowEnd && !exclude.has(r) && isCardPayment(r))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let paid = 0;
  for (const p of payments) {
    const v = inCard(p, fxRate);
    if (v == null) convertible = false;
    else paid += v;
  }

  let amountDue: number | null = null;
  let source: Evaluation['source'] = null;
  let near = false;
  if (record?.bal != null) {
    amountDue = record.bal;
    source = 'statement';
  } else if (tag.kind !== 'card' && tag.emi != null) {
    amountDue = tag.emi;
    source = 'instalment';
  } else if (tag.kind === 'card' && tag.statementDay != null && statementDate) {
    // What was owed when the statement closed: today's balance less every row
    // since. A converted card's book sum drifts (each row at its own rate), so
    // that figure is only near, and a payment within 3% of it counts as full.
    let owedBook = -input.balance;
    for (const r of rows) if (r.date > statementDate) owedBook += r.amount;
    if (fxRate === 1) {
      amountDue = Math.max(0, owedBook);
    } else if (fxRate != null) {
      amountDue = Math.max(0, Math.round(owedBook * fxRate));
      near = true;
    } else {
      convertible = false;
    }
    source = 'derived';
  }
  if (!convertible && source !== 'statement' && source !== 'instalment') {
    amountDue = null;
    source = null;
  }

  const minimum = minimumOf(tag, amountDue, record);
  let state: Evaluation['state'];
  if (record?.marked === 'paid') state = 'paid';
  else if (amountDue === 0) state = 'nothing_due';
  else if (amountDue != null && convertible) {
    const full = near ? Math.round(amountDue * 0.97) : amountDue;
    state = paid >= full ? 'paid' : paid > 0 ? 'part_paid' : 'unpaid';
  }
  else state = payments.length > 0 ? 'paid' : 'unpaid';
  return { amountDue, source, minimum, paid, payments, state, window, statementDate };
}

/** Payments after `due` that went to covering it, so the next cycle doesn't count them again. */
function latePaymentsUsed(evaluation: Evaluation, due: string, fxRate: number | null): DebtRow[] {
  const late = evaluation.payments.filter((p) => p.date > due);
  if (late.length === 0) return [];
  const onTime = evaluation.payments.filter((p) => p.date <= due);
  if (evaluation.amountDue == null) return onTime.length > 0 ? [] : late.slice(0, 1);
  let covered = onTime.reduce((sum, p) => sum + (inCard(p, fxRate) ?? 0), 0);
  const used: DebtRow[] = [];
  for (const p of late) {
    if (covered >= evaluation.amountDue) break;
    used.push(p);
    covered += inCard(p, fxRate) ?? 0;
  }
  return used;
}

/** Whether the account shows payments at all before `day`: before it, arc can't tell a miss from a gap. */
function paysIn(rows: DebtRow[], from: string, to: string): boolean {
  return rows.some((r) => r.date >= from && r.date <= to && isCardPayment(r));
}

function paysBefore(rows: DebtRow[], day: string): boolean {
  return rows.some((r) => r.date < day && isCardPayment(r));
}

function isMiss(e: Evaluation): boolean {
  if (e.state === 'unpaid') return true;
  return e.state === 'part_paid' && e.minimum != null && e.paid < e.minimum;
}

/** The state of the debt's cycle on `today` (spec §3). */
export function debtCycleState(input: DebtCycleInput, today: Date): DebtCycleState {
  const { tag } = input;
  const todayDay = localDay(today);
  const reportingDays = reportingDaysFor(tag.region);
  const upcoming = upcomingDueDate(tag, today);
  const base: DebtCycleState = {
    kind: tag.kind,
    dueDate: upcoming,
    statementDate: null,
    window: null,
    amountDue: null,
    amountDueSource: null,
    minimum: null,
    paid: 0,
    left: null,
    state: 'unpaid',
    daysUntilDue: upcoming ? Math.max(0, daysBetween(todayDay, upcoming)) : null,
    daysPastDue: 0,
    reportingDays,
    missed: null,
  };
  if (input.balance >= 0) return { ...base, state: 'nothing_due' };
  if (!upcoming) return base;

  // The cycle just gone, judged with every payment up to today.
  const prevDue = previousDueDate(tag, upcoming);
  let consumed: ReadonlySet<DebtRow> = new Set();
  let missed: DebtCycleState['missed'] = null;
  let prevEval: Evaluation | null = null;
  if (prevDue && prevDue < todayDay) {
    const prevWindow = cycleWindow(tag, prevDue);
    if (paysBefore(input.rows, prevWindow.startDay) || input.cycles.some((c) => c.due === prevDue)) {
      prevEval = evaluate(input, prevDue, todayDay, new Set());
      consumed = new Set(latePaymentsUsed(prevEval, prevDue, input.fxRate));
      if (isMiss(prevEval) && tag.autopay.kind === 'none') {
        missed = {
          dueDate: prevDue,
          daysPastDue: daysBetween(prevDue, todayDay),
          minimum: prevEval.minimum,
          left: prevEval.amountDue != null ? Math.max(0, prevEval.amountDue - prevEval.paid) : null,
        };
      }
    }
  }

  const windowEnd = todayDay > upcoming ? todayDay : upcoming;
  const up = evaluate(input, upcoming, windowEnd, consumed);

  // Still the missed cycle's time: before the next one's window opens.
  if (missed && prevEval && todayDay < up.window.startDay) {
    return {
      ...base,
      dueDate: prevDue,
      statementDate: prevEval.statementDate,
      window: prevEval.window,
      amountDue: prevEval.amountDue,
      amountDueSource: prevEval.source,
      minimum: prevEval.minimum,
      paid: prevEval.paid,
      left: missed.left,
      state: 'overdue',
      daysUntilDue: 0,
      daysPastDue: missed.daysPastDue,
      missed,
    };
  }

  const left = up.amountDue != null ? Math.max(0, up.amountDue - up.paid) : null;
  let state: DebtCycleStatus = up.state;
  if (tag.autopay.kind !== 'none' && state !== 'nothing_due') state = up.state === 'paid' ? 'paid' : 'autopay';
  const pastDue = todayDay > upcoming && (state === 'unpaid' || (state === 'part_paid' && isMiss(up)));
  if (pastDue && tag.autopay.kind === 'none') state = 'overdue';
  const daysPastDue = todayDay > upcoming ? daysBetween(upcoming, todayDay) : 0;
  return {
    ...base,
    statementDate: up.statementDate,
    window: up.window,
    amountDue: up.amountDue,
    amountDueSource: up.source,
    minimum: up.minimum,
    paid: up.paid,
    left,
    state,
    daysPastDue: state === 'overdue' ? daysPastDue : 0,
    missed: missed ?? (state === 'overdue'
      ? { dueDate: upcoming, daysPastDue, minimum: up.minimum, left }
      : null),
  };
}

// ---------------------------------------------------------------------------
// Past cycles: dots and streaks (spec §3.6)
// ---------------------------------------------------------------------------

export type CycleDot = 'full' | 'min' | 'none' | 'skip';

export interface DebtCycleHistory {
  /** Oldest first, the newest judged cycle last. */
  dots: Array<{ due: string; dot: CycleDot }>;
  /** Cycles paid on time (in full or the minimum) running, to the newest. */
  onTime: number;
  /** Cycles paid in full running, to the newest. */
  inFull: number;
  /** The longest on-time run in the history. */
  bestOnTime: number;
}

function dotOf(e: Evaluation): CycleDot {
  if (e.state === 'nothing_due') return 'skip';
  if (e.state === 'paid') return 'full';
  if (e.state === 'part_paid' && (e.minimum == null || e.paid >= e.minimum)) return 'min';
  return 'none';
}

/**
 * The last `count` cycles, each judged by its due date (on time only), for
 * the dots and streaks. The cycle ahead joins once it's already paid. A cycle
 * from before the account shows any payment, or with nothing due, is `skip`
 * and breaks nothing; a miss ends a run, and nothing says it was lost.
 */
export function debtCycleHistory(input: DebtCycleInput, today: Date, count = 12): DebtCycleHistory {
  const { tag } = input;
  const todayDay = localDay(today);
  const upcoming = upcomingDueDate(tag, today);
  const empty: DebtCycleHistory = { dots: [], onTime: 0, inFull: 0, bestOnTime: 0 };
  if (!upcoming) return empty;

  const dues: string[] = [];
  let due: string | null = upcoming;
  while (due && dues.length < count + 1) {
    dues.unshift(due);
    due = previousDueDate(tag, due);
  }
  const dots: DebtCycleHistory['dots'] = [];
  for (const d of dues) {
    const e = evaluate(input, d, d, new Set());
    if (d === upcoming) {
      // The cycle ahead counts only once it's paid; it can't be missed yet.
      if (d >= todayDay && (e.state === 'paid' || e.state === 'nothing_due')) dots.push({ due: d, dot: dotOf(e) });
      else if (d < todayDay) dots.push({ due: d, dot: dotOf(e) });
      continue;
    }
    // Judged once the account has history for it: a payment before the cycle
    // or in it, a record, or the plan or loan already running (its first
    // instalment is a cycle too, with nothing paid before it).
    const span = cycleWindow(tag, d);
    const known = paysBefore(input.rows, span.startDay)
      || paysIn(input.rows, span.startDay, span.endDay)
      || input.cycles.some((c) => c.due === d)
      || (tag.kind === 'bnpl' && !!tag.first && d >= tag.first)
      || (tag.kind === 'loan' && !!tag.start && d.slice(0, 7) >= tag.start);
    dots.push({ due: d, dot: known ? dotOf(e) : 'skip' });
  }
  const trimmed = dots.slice(-count);

  let onTime = 0;
  let inFull = 0;
  let onTimeOpen = true;
  let inFullOpen = true;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const dot = trimmed[i].dot;
    if (dot === 'skip') continue;
    if (onTimeOpen) {
      if (dot === 'full' || dot === 'min') onTime++;
      else onTimeOpen = false;
    }
    if (inFullOpen) {
      if (dot === 'full') inFull++;
      else inFullOpen = false;
    }
  }
  let best = 0;
  let run = 0;
  for (const { dot } of trimmed) {
    if (dot === 'skip') continue;
    run = dot === 'full' || dot === 'min' ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { dots: trimmed, onTime, inFull, bestOnTime: best };
}
