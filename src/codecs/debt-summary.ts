// Ported from the arc app (budgetarc 1.0.49, cycleFromStatements 1.0.50): the pure parts of
// services/DebtCycleService.ts, plus readFxNote from utils/fxNote.ts and
// currencyRulesFrom from utils/currencyRuleParse.ts. The reads (SQLite there,
// @actual-app/api here) live in src/operations/debts.ts; everything that
// decides a figure is here, so the CLI and the app give the same answers.
import {
  type CycleAmount,
  type CycleSource,
  type CycleUpdate,
  type DebtCycleHistory,
  type DebtCycleInput,
  type DebtCycleRecord,
  type DebtCycleState,
  type DebtRow,
  type LatestLimit,
  dayOfMonthAfter,
  debtCycleHistory,
  debtCycleState,
  localDay,
} from './debt-cycle.js';
import { EMPTY_DEBT_TAG, type DebtKind, type DebtTag } from './debt-tag.js';
import { debtChargeKind } from './debt-charges.js';
import { type DailyNet, type DebtProgress, debtProgressOf } from './debt-progress.js';
import { learnCycle, projectCycles, tagDueDay } from './statement-cycle-learning.js';

// ── FX prefixes in a row's note (utils/fxNote.ts readFxNote) ────────────────

export interface FxPrefix {
  /** ISO code, from the prefix's own text; null when it names none (very old notes). */
  currency: string | null;
  /** The amount in `currency`, always positive (the sign is the stored amount's). */
  amount: number;
  /** Budget currency per one unit of `currency`. */
  rate: number;
  label: string;
}

const LEADING_PREFIX = /^\s*([^•()]*?\S)\s*\(FX [Rr]ate:\s*([0-9.]+)\)\s*(?:•\s*)?/;
const CODE = /\b([A-Z]{3})\b/g;

function parseLabel(label: string): { currency: string | null; amount: number } | null {
  const codes = [...label.matchAll(CODE)].map((m) => m[1]);
  const numeric = label.replace(/[^0-9.]/g, '');
  const amount = parseFloat(numeric);
  if (!Number.isFinite(amount)) return null;
  return { currency: codes.length ? codes[codes.length - 1] : null, amount: Math.abs(amount) };
}

export function readFxNote(note: string | null | undefined): { prefixes: FxPrefix[]; rest: string } {
  let rest = note ?? '';
  const prefixes: FxPrefix[] = [];
  while (prefixes.length < 2) {
    const m = rest.match(LEADING_PREFIX);
    if (!m) break;
    const parsed = parseLabel(m[1]);
    const rate = parseFloat(m[2]);
    if (!parsed || !Number.isFinite(rate)) break;
    prefixes.push({ ...parsed, rate, label: m[1].trim() });
    rest = rest.slice(m[0].length);
  }
  return { prefixes, rest };
}

// ── Currency rules (utils/currencyRuleParse.ts) ─────────────────────────────

export interface CurrencyRule {
  id: string;
  currencyCode: string;
  /** Budget currency per one unit of the account's (amount = foreign × rate). */
  rate: number;
  accountId: string;
}

export function currencyRulesFrom(rules: ReadonlyArray<any>): CurrencyRule[] {
  const currencyRules: CurrencyRule[] = [];
  rules.forEach((rule: any) => {
    rule.actions?.forEach((action: any) => {
      if (action.field === 'notes' && action.options?.template) {
        const match = action.options.template.match(/(\w+) \(FX [Rr]ate: ([0-9.]+)\)/);
        if (match) {
          const [, code, rate] = match;
          const parsedRate = parseFloat(rate);
          const accountCondition = rule.conditions?.find((c: any) => c.field === 'acct' || c.field === 'account');
          const accountId = accountCondition?.value;
          if (accountId) {
            currencyRules.push({ id: rule.id, currencyCode: code, rate: parsedRate, accountId });
          }
        }
      }
    });
  });
  return currencyRules;
}

// ── Reading context ─────────────────────────────────────────────────────────

/** Read once and shared across the accounts of one pass. */
export interface DebtReadContext {
  rules: CurrencyRule[];
  /** The budget's currency, when it could be read: a card tagged in it is in the budget's. */
  budget?: string | null;
  /** Whose late-reporting rules apply when the tag names no region (the phone's region in the app). */
  region?: string | null;
}

/**
 * The debt's own currency, tag or no tag: the tag's, else the account's
 * currency rule; null is the budget's.
 */
export function cardCurrencyOf(tag: DebtTag | null | undefined, accountId: string, ctx: DebtReadContext): string | null {
  const code = tag?.currency?.toUpperCase() ?? ctx.rules.find((r) => r.accountId === accountId)?.currencyCode.toUpperCase() ?? null;
  return code && ctx.budget && code === ctx.budget.toUpperCase() ? null : code;
}

/** One live row as the app's SQL reads it (split lines, never their parent). */
export interface RawDebtRow {
  amount: number;
  date: string;
  category_id: string | null;
  /** 1 when the other side is an account in this budget. */
  transfer: number;
  category_is_income: number | null;
  starting: number | null;
  /** Payee, imported payee and notes, joined with spaces. */
  text: string | null;
  notes: string | null;
}

export function toDebtRows(raw: RawDebtRow[], currency: string | null): { rows: DebtRow[]; noteRate: number | null } {
  let noteRate: number | null = null;
  let noteRateDay = '';
  const rows = raw.map((r): DebtRow => {
    // A starting balance is owed money, never a payment.
    const starting = r.starting === 1;
    let native: number | null = null;
    if (currency) {
      const prefix = readFxNote(r.notes).prefixes.find((p) => p.currency === currency);
      if (prefix) {
        native = Math.sign(r.amount) * Math.round(prefix.amount * 100);
        if (prefix.rate > 0 && r.date >= noteRateDay) {
          noteRate = 1 / prefix.rate;
          noteRateDay = r.date;
        }
      }
    }
    return {
      amount: r.amount,
      date: r.date,
      transfer: !starting && r.transfer === 1,
      categoryIsIncome: starting ? false : r.category_is_income == null ? null : r.category_is_income === 1,
      text: r.text ?? '',
      native,
      categoryId: r.category_id,
    };
  });
  return { rows, noteRate };
}

/** Everything debtCycleState needs, from what the caller read (debtCycleInputFor). */
export function debtCycleInputFrom(
  accountId: string,
  tag: DebtTag,
  raw: { rows: RawDebtRow[]; balance: number; cycles: DebtCycleRecord[] },
  ctx: DebtReadContext,
): DebtCycleInput {
  const currency = cardCurrencyOf(tag, accountId, ctx);
  const { rows, noteRate } = toDebtRows(raw.rows, currency);
  const rule = currency ? ctx.rules.find((r) => r.accountId === accountId && r.currencyCode.toUpperCase() === currency) : undefined;
  const fxRate = !currency ? 1 : rule && rule.rate > 0 ? 1 / rule.rate : noteRate;
  return {
    tag: tag.region ? tag : { ...tag, region: ctx.region ?? null },
    cycles: raw.cycles,
    balance: raw.balance,
    rows,
    fxRate,
  };
}

// ── Statement figures (recordStatement) ─────────────────────────────────────

/** Figures from a statement or due notice (spec §4.1), decimals in the statement's currency. */
export interface StatementFigures {
  currency?: string | null;
  statementBalance?: number | null;
  minimumDue?: number | null;
  dueDate?: string | null;
  statementDate?: string | null;
  creditLimit?: number | null;
  availableLimit?: number | null;
  previousBalance?: number | null;
  interestCharged?: number | null;
  fees?: number | null;
  outstanding?: number | null;
  principalPaid?: number | null;
  interestPaid?: number | null;
}

const FIGURE_FIELDS: Array<[keyof StatementFigures, CycleAmount]> = [
  ['statementBalance', 'bal'],
  ['minimumDue', 'min'],
  ['creditLimit', 'limit'],
  ['availableLimit', 'avail'],
  ['previousBalance', 'prev'],
  ['interestCharged', 'int'],
  ['fees', 'fees'],
  ['outstanding', 'out'],
  ['principalPaid', 'princ'],
  ['interestPaid', 'intpd'],
];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A decimal to the ×100 integer Actual stores for every currency (spec §0). */
const minor = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : undefined;

/**
 * The due date a statement is for: its own, else the tag's due day after its
 * statement date, else (for an available limit alone) the cycle `onDay` is in.
 */
export function statementDueDate(figures: StatementFigures, tag: DebtTag | null, onDay: string): string | null {
  if (figures.dueDate && DAY.test(figures.dueDate)) return figures.dueDate;
  if (!tag || tag.dueDay == null) return null;
  const after = figures.statementDate && DAY.test(figures.statementDate) ? figures.statementDate : onDay;
  return dayOfMonthAfter(after, tag.dueDay);
}

/**
 * What recordStatement would write: a cycle update, a latest-limit (no due
 * day to file it under), or nothing.
 */
export type StatementPlan =
  | { kind: 'cycle'; update: CycleUpdate }
  | { kind: 'latest'; avail: number; day: string }
  | { kind: 'nothing' };

export function planStatement(
  figures: StatementFigures,
  tag: DebtTag | null,
  cardCurrency: string | null,
  onDay: string,
): StatementPlan {
  const due = statementDueDate(figures, tag, onDay);
  const sameCurrency = !figures.currency || !cardCurrency || figures.currency.toUpperCase() === cardCurrency;
  if (!due) {
    const avail = sameCurrency ? minor(figures.availableLimit) : undefined;
    return avail !== undefined ? { kind: 'latest', avail, day: onDay } : { kind: 'nothing' };
  }
  const update: CycleUpdate = { due };
  if (figures.statementDate && DAY.test(figures.statementDate)) update.stmt = figures.statementDate;
  if (sameCurrency) {
    for (const [from, to] of FIGURE_FIELDS) {
      const value = minor(figures[from]);
      if (value !== undefined) update[to] = value;
    }
  }
  if (Object.keys(update).length === 1) return { kind: 'nothing' };
  return { kind: 'cycle', update };
}

/** recordLatestLimit's rule: the newer one is kept. */
export function newerLatestLimit(held: LatestLimit | null, avail: number, day: string, source: CycleSource, at: number): LatestLimit | null {
  if (held && (held.day > day || (held.day === day && held.at >= at))) return null;
  return { avail: Math.round(avail), day, at, src: source };
}

// ── The debt home: one summary per debt ─────────────────────────────────────

const FRESH_AVAIL_MS = 7 * 24 * 60 * 60 * 1000;

/** actualBudgetService.getAutoDebtInterestCategoryIds: categories named for interest or bank charges. */
const INTEREST_CATEGORY_PATTERNS = ['interest', 'finance charge', 'bank charge', 'bank charges', 'bank fee', 'late fee', 'loan charge'];

export function autoDebtInterestCategoryIds(categories: ReadonlyArray<{ id: string; name?: string | null }>): string[] {
  return categories
    .filter((c) => {
      const lower = (c.name || '').toLowerCase();
      return INTEREST_CATEGORY_PATTERNS.some((p) => lower.includes(p));
    })
    .map((c) => c.id);
}

export interface DebtSummary {
  accountId: string;
  kind: DebtKind;
  /** Null for an untagged debt (a card or loan by its type or place). */
  tag: DebtTag | null;
  /** Null without a due day. */
  state: DebtCycleState | null;
  history: DebtCycleHistory | null;
  progress: DebtProgress;
  /** Interest and fees this calendar year and this month, book currency, positive. */
  charges: { interestYear: number; feesYear: number; interestMonth: number; feesMonth: number };
  /** Credit limit, card currency: the tag's, else the newest a statement gave. */
  limit: number | null;
  /** Owed now ÷ limit, 0–1+; null without a limit or a rate to compare them. */
  utilisation: number | null;
  limitBook: number | null;
  owedBook: number;
  /** Card currency per budget unit (1 in the budget's own); null when it can't be had. */
  fxRate: number | null;
  /** The row's ring, 0–1: this cycle paid for a card, the loan paid off for a loan. */
  ring: number;
  /** Balance ÷ limit at the newest statement and the one before; null where either isn't known. */
  statementUtilisation: [number | null, number | null];
  /** The cycle came from the statements (cycleFromStatements), not from a due day the user set. */
  cycleLearned?: boolean;
  /** CLI: the days that cycle judged by (the app reads them again with statementDueDayOf). */
  learnedCycle?: { dueDay: number; statementDay: number | null } | null;
}

const STMT_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The cycle of a card whose tag has no due day, from what its statements
 * printed (owner, 1.0.50): the learned cycle when two or more statements agree
 * (utils/statementCycleLearning), else the newest statement's own due date.
 * Read-time only, so a linked statement shows its line: the tag is never
 * written, the values stay "learned", and what the user typed always wins (a
 * due day, or "no" to a learned one). Null when there's nothing to go on.
 */
export function cycleFromStatements(
  tag: Pick<DebtTag, 'kind' | 'dueDay' | 'statementDay' | 'askDeclined'>,
  cycles: readonly DebtCycleRecord[],
  currency?: string | null,
): { dueDay: number; statementDay: number | null } | null {
  if (tag.kind === 'bnpl' || tag.dueDay != null || tag.askDeclined) return null;
  // Statements: a record with a balance or a minimum (a limit alone is a purchase alert's).
  const stated = cycles.filter((c) => STMT_DAY.test(c.due) && (c.bal != null || c.min != null));
  if (stated.length === 0) return null;
  const learned = learnCycle(stated.filter((c) => c.stmt).map((c) => ({ stmt: c.stmt!, due: c.due })), { currency });
  if (learned) {
    const latest = stated.map((c) => c.stmt ?? '').filter(Boolean).sort().pop()!;
    const day = tagDueDay(learned, projectCycles(learned, latest));
    if (day != null) return { dueDay: day, statementDay: tag.statementDay ?? learned.statementDay };
  }
  const newest = [...stated].sort((a, b) => (a.due < b.due ? 1 : -1))[0];
  const statementDay = tag.statementDay ?? (newest.stmt && STMT_DAY.test(newest.stmt) ? +newest.stmt.slice(8, 10) : null);
  return { dueDay: +newest.due.slice(8, 10), statementDay };
}

function chargesOf(rows: DebtRow[], interestCategories: ReadonlySet<string>, today: Date) {
  const year = `${today.getFullYear()}-01-01`;
  const month = `${localDay(today).slice(0, 7)}-01`;
  const out = { interestYear: 0, feesYear: 0, interestMonth: 0, feesMonth: 0 };
  for (const r of rows) {
    if (r.amount >= 0 || r.date < year) continue;
    const kind = debtChargeKind(r.text) ?? (r.categoryId && interestCategories.has(r.categoryId) ? 'interest' : null);
    if (!kind) continue;
    const v = -r.amount;
    if (kind === 'interest') {
      out.interestYear += v;
      if (r.date >= month) out.interestMonth += v;
    } else {
      out.feesYear += v;
      if (r.date >= month) out.feesMonth += v;
    }
  }
  return out;
}

function ringOf(kind: DebtKind, tag: DebtTag | null, state: DebtCycleState | null, owed: number, progress: DebtProgress): number {
  if (kind === 'card' && state) {
    if (state.state === 'paid' || state.state === 'nothing_due') return 1;
    if (state.amountDue && state.amountDue > 0) return Math.min(1, state.paid / state.amountDue);
    return 0;
  }
  if (kind === 'loan' && tag?.principal) return Math.min(1, Math.max(0, (tag.principal - owed) / tag.principal));
  if (kind === 'bnpl' && tag?.emi && tag.instalments) {
    const total = tag.emi * tag.instalments;
    return Math.min(1, Math.max(0, (total - owed) / total));
  }
  return progress.paidOff;
}

/** debtSummaryFor, given what it reads. */
export function debtSummaryOf(
  accountId: string,
  kind: DebtKind,
  tag: DebtTag | null,
  read: { rows: RawDebtRow[]; balance: number; cycles: DebtCycleRecord[]; latest: LatestLimit | null; dailyNets: DailyNet[] },
  interestCategories: ReadonlySet<string>,
  today: Date,
  ctx: DebtReadContext,
): DebtSummary {
  const base: DebtTag = tag ?? { ...EMPTY_DEBT_TAG, kind, other: [] };
  // No due day typed: the statements' own cycle, learned, never written to the tag.
  const learnedCycle = cycleFromStatements(base, read.cycles, cardCurrencyOf(tag, accountId, ctx));
  const judged: DebtTag = learnedCycle ? { ...base, ...learnedCycle } : base;
  const input = debtCycleInputFrom(accountId, judged, read, ctx);
  const hasDue = judged.kind === 'bnpl' ? !!judged.first : judged.dueDay != null;
  const state = hasDue ? debtCycleState(input, today) : null;
  const history = hasDue ? debtCycleHistory(input, today) : null;
  const progress = debtProgressOf(read.dailyNets, localDay(today));
  const limit = judged.limit ?? input.cycles.find((c) => c.limit != null)?.limit ?? null;
  const owedCard = input.fxRate != null ? Math.max(0, Math.round(-input.balance * input.fxRate)) : null;
  const latestLimit = read.latest;
  const avails = [
    ...input.cycles.filter((c) => c.avail != null).map((c) => ({ avail: c.avail!, at: c.at })),
    ...(latestLimit ? [{ avail: latestLimit.avail, at: latestLimit.at }] : []),
  ].sort((a, b) => b.at - a.at);
  const freshAvail = avails[0] && today.getTime() - avails[0].at <= FRESH_AVAIL_MS ? avails[0].avail : null;
  const statements = input.cycles.filter((c) => c.bal != null).sort((a, b) => (a.due < b.due ? 1 : a.due > b.due ? -1 : 0));
  const utilisationAt = (c: (typeof statements)[number] | undefined) => {
    const cap = c ? c.limit ?? judged.limit : null;
    return c && cap && cap > 0 ? Math.max(0, c.bal!) / cap : null;
  };
  return {
    accountId,
    kind,
    tag,
    state,
    history,
    progress,
    charges: chargesOf(input.rows, interestCategories, today),
    limit,
    utilisation: limit && limit > 0
      ? freshAvail != null ? Math.max(0, limit - freshAvail) / limit : owedCard != null ? owedCard / limit : null
      : null,
    limitBook: limit && limit > 0 && input.fxRate ? limit / input.fxRate : null,
    owedBook: Math.max(0, -input.balance),
    fxRate: input.fxRate,
    ring: ringOf(kind, tag, state, Math.max(0, -input.balance), progress),
    statementUtilisation: [utilisationAt(statements[0]), utilisationAt(statements[1])],
    cycleLearned: !!learnedCycle,
    learnedCycle,
  };
}
