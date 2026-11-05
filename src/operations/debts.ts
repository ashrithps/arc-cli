/**
 * Debts — credit cards, loans and BNPL plans, as the arc app (1.0.49+) sees
 * them: each one a cycle with a due date, an amount due, a minimum and a
 * state (paid / part paid / unpaid / overdue), plus payoff maths and the
 * "Pay here first" plan across them all.
 *
 * Where it lives (budgetarc docs/specs/debt-cycle.md):
 *   account-<id>             one `#debt|` line: due/statement day, kind, limit,
 *                            rate, minimum rule, autopay, loan/BNPL schedule…
 *   arc-debt-cycles:<id>     JSON per-cycle figures (statement balance, minimum,
 *                            limits, "marked paid"), newest 13 kept
 *
 * The app and the CLI write the same notes on the same budget. Every rule
 * that decides a figure is in src/codecs/debt-*.ts, ported near-verbatim; this
 * file only reads the budget and writes notes, read-modify-write inside the
 * SafeWriter callback (`mutateNote`).
 *
 * Amounts are integer minor units: "card" figures are ×100 of the debt's own
 * currency (the tag's `cur`, else the account's FX rule), "book" figures are
 * in the budget's currency.
 */
import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import {
  EMPTY_DEBT_TAG,
  findDebtLine,
  isEmptyDebtTag,
  noteWithDebtTag,
  parseDebtNote,
  type DebtKind,
  type DebtTag,
} from '../codecs/debt-tag.js';
import {
  addDays,
  debtCyclesNoteId,
  encodeDebtCycles,
  localDay,
  mergeDebtCycle,
  parseDebtCycles,
  parseLatestLimit,
  type CycleSource,
  type DebtCycleRecord,
  type LatestLimit,
} from '../codecs/debt-cycle.js';
import {
  autoDebtInterestCategoryIds,
  cardCurrencyOf,
  currencyRulesFrom,
  debtCycleInputFrom,
  debtSummaryOf,
  newerLatestLimit,
  planStatement,
  type DebtReadContext,
  type DebtSummary,
  type RawDebtRow,
  type StatementFigures,
} from '../codecs/debt-summary.js';
import { debtClassOf, debtPaySourceOf, isDebt, isNeverDebt, nonDebtAccountIdsFrom } from '../codecs/debt-accounts.js';
import { type DailyNet, debtProgressOf, mergeDailyNets } from '../codecs/debt-progress.js';
import {
  estimatedMinimum,
  instalmentSplit,
  loanPaymentOf,
  loanScheduleAt,
  nextPaymentDay,
  payMore,
  payoffMonth,
  payoffPlan,
  payoffRun,
  prepay,
  type PlanMethod,
} from '../codecs/debt-payoff.js';
import { debtFreeOf, firstDueOf, planDebtOf } from '../codecs/debt-plan.js';
import { bookToCard } from '../codecs/debt-money.js';
import { debtMomentsReached } from '../codecs/debt-milestones.js';
import { accountNoteId, mutateNote, readAllNotes, type NoteRow } from './notes.js';
import { validateId } from '../utils/validation.js';

/** Rows read for a state: a year of dots, the cycle before it, and a payment to show the account records them. */
const ROW_DAYS = 430;
const STARTING_BALANCE_CATEGORY_NAME = 'Starting Balances';

// ── Reading the budget ──────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  name: string;
  type?: string | null;
  offbudget?: boolean;
  closed?: boolean;
}

interface LedgerRow {
  id: string;
  date: string;
  amount: number;
  notes: string | null;
  imported_payee: string | null;
  payee: string | null;
  category: string | null;
  transfer_id: string | null;
}

interface BudgetRead {
  accounts: AccountRow[];
  notes: NoteRow[];
  noteById: Map<string, string>;
  ctx: DebtReadContext;
  interestCategories: Set<string>;
  payees: Map<string, { name: string; transferAcct: string | null }>;
  categoryKind: Map<string, { isIncome: boolean; isStarting: boolean }>;
  notDebt: Set<string>;
}

/** This machine's region, as the app falls back to the phone's when the tag names none. */
function localRegion(): string | null {
  try {
    const locale = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).maximize();
    return locale.region && /^[A-Z]{2}$/.test(locale.region) ? locale.region : null;
  } catch {
    return null;
  }
}

/** Actual's own currency for the budget (preference `defaultCurrencyCode`), when it has one. */
async function budgetCurrency(client: ActualClient): Promise<string | null> {
  const ok = (v: unknown) => {
    const code = typeof v === 'string' ? v.trim().toUpperCase() : '';
    return /^[A-Z]{3}$/.test(code) ? code : null;
  };
  try {
    const prefs: any = await client.internals.send('preferences/get' as any, undefined as any);
    const code = ok(prefs?.defaultCurrencyCode);
    if (code) return code;
  } catch {
    // Older servers: fall through.
  }
  try {
    const res: any = await client.api.aqlQuery(
      client.api.q('preferences').filter({ id: 'defaultCurrencyCode' }).select(['value'])
    );
    return ok(res?.data?.[0]?.value);
  } catch {
    return null;
  }
}

async function readBudget(client: ActualClient): Promise<BudgetRead> {
  client.ensureConnected();
  const [accounts, notes, rules, payees, groups, currency] = await Promise.all([
    client.api.getAccounts() as Promise<any[]>,
    readAllNotes(client),
    (client.api.getRules() as Promise<any[]>).catch(() => [] as any[]),
    client.api.getPayees() as Promise<any[]>,
    client.api.getCategoryGroups() as Promise<any[]>,
    budgetCurrency(client),
  ]);
  const categoryKind = new Map<string, { isIncome: boolean; isStarting: boolean }>();
  const categories: Array<{ id: string; name: string }> = [];
  for (const g of groups ?? []) {
    for (const c of g.categories ?? []) {
      // The group decides income, as the app's v_category_kind does.
      const isIncome = !!(g.is_income ?? c.is_income);
      categoryKind.set(c.id, { isIncome, isStarting: isIncome && c.name === STARTING_BALANCE_CATEGORY_NAME });
      categories.push({ id: c.id, name: c.name });
    }
  }
  return {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type ?? null, offbudget: !!a.offbudget, closed: !!a.closed })),
    notes,
    noteById: new Map(notes.map((n) => [n.id, n.note])),
    ctx: { rules: currencyRulesFrom(rules ?? []), budget: currency, region: localRegion() },
    interestCategories: new Set(autoDebtInterestCategoryIds(categories)),
    payees: new Map((payees ?? []).map((p: any) => [p.id, { name: p.name ?? '', transferAcct: p.transfer_acct ?? null }])),
    categoryKind,
    notDebt: nonDebtAccountIdsFrom(notes),
  };
}

/** Every live row on the account: split lines, never their parent (as the app's SQL counts them). */
async function ledgerOf(client: ActualClient, accountId: string): Promise<LedgerRow[]> {
  const res: any = await client.api.aqlQuery(
    client.api
      .q('transactions')
      .filter({ account: accountId })
      .options({ splits: 'inline' })
      .select(['id', 'date', 'amount', 'notes', 'imported_payee', 'payee', 'category', 'transfer_id'])
  );
  return (res?.data ?? []) as LedgerRow[];
}

interface AccountRead {
  balance: number;
  rows: RawDebtRow[];
  dailyNets: DailyNet[];
  cycles: DebtCycleRecord[];
  latest: LatestLimit | null;
  /** The other side of the newest transfer into this debt. */
  lastPaidFrom: string | null;
}

async function readAccount(client: ActualClient, budget: BudgetRead, accountId: string, today: Date): Promise<AccountRead> {
  const ledger = await ledgerOf(client, accountId);
  const since = addDays(localDay(today), -ROW_DAYS);
  let balance = 0;
  const nets = new Map<string, number>();
  const rows: RawDebtRow[] = [];
  let lastPaid: { date: string; acct: string } | null = null;
  for (const t of ledger) {
    const amount = t.amount ?? 0;
    balance += amount;
    nets.set(t.date, (nets.get(t.date) ?? 0) + amount);
    const payee = t.payee ? budget.payees.get(t.payee) : undefined;
    const isTransfer = !!t.transfer_id || !!payee?.transferAcct;
    if (amount > 0 && payee?.transferAcct && (!lastPaid || t.date > lastPaid.date)) {
      lastPaid = { date: t.date, acct: payee.transferAcct };
    }
    if (t.date < since) continue;
    const kind = t.category ? budget.categoryKind.get(t.category) : undefined;
    rows.push({
      amount,
      date: t.date,
      notes: t.notes ?? null,
      category_id: t.category ?? null,
      transfer: isTransfer ? 1 : 0,
      category_is_income: kind ? (kind.isIncome ? 1 : 0) : null,
      starting: kind?.isStarting ? 1 : 0,
      text: `${payee?.name ?? ''} ${t.imported_payee ?? ''} ${t.notes ?? ''}`,
    });
  }
  const cyclesNote = budget.noteById.get(debtCyclesNoteId(accountId)) ?? null;
  return {
    balance,
    rows,
    dailyNets: [...nets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, net]) => ({ date, net })),
    cycles: parseDebtCycles(cyclesNote),
    latest: parseLatestLimit(cyclesNote),
    lastPaidFrom: lastPaid?.acct ?? null,
  };
}

function tagOf(budget: BudgetRead, accountId: string): DebtTag | null {
  return parseDebtNote(budget.noteById.get(accountNoteId(accountId)) ?? null);
}

async function findAccount(client: ActualClient, accountId: string): Promise<AccountRow> {
  validateId(accountId);
  const accounts = (await client.api.getAccounts()) as any[];
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);
  return account;
}

// ── Shapes returned ─────────────────────────────────────────────────────────

export interface DebtListItem {
  accountId: string;
  accountName: string;
  kind: DebtKind;
  /** False for a debt arc found by its type or place (no `#debt|` line yet). */
  tagged: boolean;
  dueDay: number | null;
  statementDay: number | null;
  /** The debt's own currency when it isn't the budget's; "card" amounts are in it. */
  currency: string | null;
  /** Signed account balance, budget currency (negative while owed). */
  balance: number;
  /** Owed now, budget currency. */
  owed: number;
  dueDate: string | null;
  daysUntilDue: number | null;
  /** nothing_due | autopay | paid | part_paid | unpaid | overdue; null without a due day. */
  state: string | null;
  /** Card currency. */
  amountDue: number | null;
  amountDueSource: string | null;
  minimum: number | null;
  paid: number | null;
  left: number | null;
  daysPastDue: number;
  /** Card currency. */
  limit: number | null;
  utilisation: number | null;
  rate: number | null;
  autopay: string;
  onTimeStreak: number | null;
}

function autopayText(tag: DebtTag | null): string {
  const a = tag?.autopay ?? { kind: 'none' as const };
  return a.kind === 'fixed' ? `fixed/${a.amount}` : a.kind;
}

function listItem(account: AccountRow, s: DebtSummary, budget: BudgetRead): DebtListItem {
  const tag = s.tag;
  return {
    accountId: account.id,
    accountName: account.name,
    kind: s.kind,
    tagged: !!tag,
    dueDay: tag?.dueDay ?? null,
    statementDay: tag?.statementDay ?? null,
    currency: cardCurrencyOf(tag, account.id, budget.ctx),
    balance: -s.owedBook,
    owed: s.owedBook,
    dueDate: s.state?.dueDate ?? null,
    daysUntilDue: s.state?.daysUntilDue ?? null,
    state: s.state?.state ?? null,
    amountDue: s.state?.amountDue ?? null,
    amountDueSource: s.state?.amountDueSource ?? null,
    minimum: s.state?.minimum ?? null,
    paid: s.state ? s.state.paid : null,
    left: s.state?.left ?? null,
    daysPastDue: s.state?.daysPastDue ?? 0,
    limit: s.limit,
    utilisation: s.utilisation,
    rate: tag?.rate ?? null,
    autopay: autopayText(tag),
    onTimeStreak: s.history ? s.history.onTime : null,
  };
}

interface Classified {
  account: AccountRow;
  kind: DebtKind;
  tag: DebtTag | null;
  read: AccountRead;
  summary: DebtSummary;
}

async function classifyAll(client: ActualClient, budget: BudgetRead, today: Date) {
  const debts: Classified[] = [];
  const overdrawn: Array<{ accountId: string; accountName: string; balance: number }> = [];
  for (const account of budget.accounts) {
    if (account.closed || isNeverDebt(account, budget.notDebt)) continue;
    const tag = tagOf(budget, account.id);
    // Untagged accounts are debt only while owing: the ledger says.
    const read = await readAccount(client, budget, account.id, today);
    const cls = debtClassOf({ ...account, balance: read.balance }, tag, budget.notDebt);
    if (!cls) continue;
    if (!isDebt(cls)) {
      overdrawn.push({ accountId: account.id, accountName: account.name, balance: read.balance });
      continue;
    }
    const summary = debtSummaryOf(account.id, cls.kind, tag, read, budget.interestCategories, today, budget.ctx);
    debts.push({ account, kind: cls.kind, tag, read, summary });
  }
  return { debts, overdrawn };
}

// ── list ────────────────────────────────────────────────────────────────────

export interface DebtList {
  debts: DebtListItem[];
  /** On-budget accounts below zero that aren't debt: out of every debt total. */
  overdrawn: Array<{ accountId: string; accountName: string; balance: number }>;
  totals: {
    /** Budget currency. */
    owed: number;
    interestMonth: number;
    interestYear: number;
    feesYear: number;
    /** Owed ÷ limit over the cards with a limit. */
    utilisation: number | null;
    /** Paid down since the 1st, and on average a month over the last three, budget currency. */
    downThisMonth: number;
    monthlyPaydown: number | null;
    /** The one debt-free month the app says (YYYY-MM), and how it was worked out. */
    debtFree: { month: string; by: 'minimums' | 'pace' } | null;
  };
}

const STATE_ORDER: Record<string, number> = { overdue: 0, unpaid: 1, part_paid: 2, autopay: 3, paid: 4, nothing_due: 5 };

/** Every debt: tagged accounts, and cards/loans arc finds by type or place. Most urgent first. */
export async function listDebts(client: ActualClient, now: Date = new Date()): Promise<DebtList> {
  const budget = await readBudget(client);
  const { debts, overdrawn } = await classifyAll(client, budget, now);
  const today = localDay(now);
  let interestMonth = 0;
  let interestYear = 0;
  let feesYear = 0;
  let owedWithLimit = 0;
  let limits = 0;
  for (const d of debts) {
    interestMonth += d.summary.charges.interestMonth;
    interestYear += d.summary.charges.interestYear;
    feesYear += d.summary.charges.feesYear;
    if (d.summary.limitBook) {
      owedWithLimit += d.summary.owedBook;
      limits += d.summary.limitBook;
    }
  }
  const pace = debts.length ? debtProgressOf(mergeDailyNets(debts.map((d) => d.read.dailyNets)), today) : null;
  const items = debts.map((d) => listItem(d.account, d.summary, budget));
  items.sort((a, b) => {
    const sa = STATE_ORDER[a.state ?? ''] ?? 6;
    const sb = STATE_ORDER[b.state ?? ''] ?? 6;
    if (sa !== sb) return sa - sb;
    if (a.daysUntilDue !== b.daysUntilDue) {
      if (a.daysUntilDue === null) return 1;
      if (b.daysUntilDue === null) return -1;
      return a.daysUntilDue - b.daysUntilDue;
    }
    return a.accountName.localeCompare(b.accountName);
  });
  return {
    debts: items,
    overdrawn,
    totals: {
      owed: debts.reduce((sum, d) => sum + d.summary.owedBook, 0),
      interestMonth,
      interestYear,
      feesYear,
      utilisation: limits > 0 ? owedWithLimit / limits : null,
      downThisMonth: pace?.downThisMonth ?? 0,
      monthlyPaydown: pace?.monthlyPaydown ?? null,
      debtFree: debtFreeOf(debts.map((d) => d.summary), pace, today),
    },
  };
}

// ── show ────────────────────────────────────────────────────────────────────

/** What the debt pays a month, card currency: its minimum, its rule, its instalment, else an estimate. */
function monthlyPaymentOf(s: DebtSummary): { amount: number | null; source: 'minimum' | 'rule' | 'instalment' | 'estimate' | null } {
  const owedCard = bookToCard(s.owedBook, s.fxRate);
  if (s.kind !== 'card') {
    const p = loanPaymentOf(s.tag);
    if (p) return { amount: p, source: 'instalment' };
  } else if (s.state?.minimum) {
    return { amount: s.state.minimum, source: 'minimum' };
  } else if (s.tag?.min && owedCard != null) {
    const min = s.tag.min;
    const amount = min.kind === 'all' ? owedCard : Math.min(owedCard, Math.max(Math.round((owedCard * min.percent) / 100), min.floor ?? 0));
    return { amount, source: 'rule' };
  }
  if (owedCard == null) return { amount: null, source: null };
  return { amount: estimatedMinimum(owedCard, s.tag?.rate ?? null), source: 'estimate' };
}

/** One debt in full: its tag, this cycle, the past year's dots, progress, costs, payoff, and the records behind them. */
export async function showDebt(client: ActualClient, accountId: string, now: Date = new Date()) {
  const budget = await readBudget(client);
  const account = budget.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);
  const tag = tagOf(budget, accountId);
  const read = await readAccount(client, budget, accountId, now);
  const cls = debtClassOf({ ...account, balance: read.balance }, tag, budget.notDebt);
  if (!cls || !isDebt(cls)) {
    throw new Error(
      `${account.name} is not a debt${cls?.kind === 'overdrawn' ? ' (it is an overdrawn account)' : ''}. ` +
        `Mark it with \`arc debts set --account "${account.name}" --kind card --due <day>\`.`
    );
  }
  const today = localDay(now);
  const s = debtSummaryOf(accountId, cls.kind, tag, read, budget.interestCategories, now, budget.ctx);
  const judged: DebtTag = tag ?? { ...EMPTY_DEBT_TAG, kind: cls.kind, other: [] };
  const owedCard = bookToCard(s.owedBook, s.fxRate);
  const rate = tag?.rate ?? null;

  const payment = monthlyPaymentOf(s);
  const run = owedCard != null && payment.amount ? payoffRun(owedCard, rate ?? 0, payment.amount) : null;
  const settled = s.state?.state === 'paid' || s.state?.state === 'nothing_due';
  const payoff = owedCard == null
    ? null
    : {
        owed: owedCard,
        payment: payment.amount,
        paymentSource: payment.source,
        months: run?.months ?? null,
        interest: run?.interest ?? null,
        payoffMonth: run ? payoffMonth(nextPaymentDay(s.state?.dueDate, settled, today), run.months) : null,
        neverClears: payment.amount != null && owedCard > 0 && run == null,
      };

  const schedule = cls.kind === 'loan' && tag
    ? loanScheduleAt({ principal: tag.principal, rate: tag.rate, emi: tag.emi, start: tag.start, term: tag.term, dueDay: tag.dueDay }, today)
    : null;
  const input = debtCycleInputFrom(accountId, judged, read, budget.ctx);
  // Loans in another currency than the budget's get no suggestion (spec §7).
  const split = cls.kind === 'loan' && !cardCurrencyOf(tag, accountId, budget.ctx)
    ? instalmentSplit(input.rows, read.balance, rate, today, undefined, loanPaymentOf(tag))
    : null;

  const taggedIds = new Set(budget.accounts.filter((a) => tagOf(budget, a.id)).map((a) => a.id));
  const payFrom = debtPaySourceOf(
    budget.accounts.map((a) => ({ ...a, balance: 0 })),
    accountId,
    read.lastPaidFrom,
    taggedIds,
    budget.notDebt,
  );

  // Milestones: the facts the app's debtMilestonesRuntime hands its ledger.
  const fromSchedule = cls.kind !== 'card' && !!(tag?.principal || (tag?.emi && tag?.instalments));
  const carried = cls.kind === 'card' && !!s.history?.dots.some((d) => d.dot === 'min' || d.dot === 'none');
  const milestones = debtMomentsReached({
    id: accountId,
    kind: cls.kind,
    paidOff: fromSchedule ? s.ring : s.progress.paidOff,
    owed: s.owedBook,
    carried,
    onTime: s.history?.onTime ?? 0,
    statementUtilisation: s.statementUtilisation,
    hasHistory: !!s.history && s.history.dots.some((d) => d.dot !== 'skip'),
    fromSchedule,
  });

  return {
    accountId,
    accountName: account.name,
    kind: cls.kind,
    tagged: !!tag,
    tagLine: findDebtLine(budget.noteById.get(accountNoteId(accountId)) ?? null),
    tag,
    currency: cardCurrencyOf(tag, accountId, budget.ctx),
    budgetCurrency: budget.ctx.budget ?? null,
    fxRate: s.fxRate,
    balance: read.balance,
    owed: s.owedBook,
    owedCard,
    cycle: s.state,
    history: s.history,
    progress: s.progress,
    charges: s.charges,
    limit: s.limit,
    utilisation: s.utilisation,
    statementUtilisation: s.statementUtilisation,
    ring: s.ring,
    payoff,
    loanSchedule: schedule,
    instalmentSplit: split,
    payFrom: payFrom ? { accountId: payFrom.id, accountName: payFrom.name } : null,
    milestones,
    promoEnds: tag?.promoEnds ?? null,
    cycleRecords: read.cycles,
    latestLimit: read.latest,
  };
}

// ── set / clear ─────────────────────────────────────────────────────────────

/** What `set` can change; `null` clears a field. Amounts are minor units of the debt's currency. */
export type DebtTagUpdates = Partial<Omit<DebtTag, 'other'>>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

function check(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

/** Refuse what the codec would silently drop, naming the field. */
export function validateDebtUpdates(u: DebtTagUpdates): void {
  const day = (v: number | null | undefined, name: string) =>
    check(v == null || (Number.isInteger(v) && v >= 1 && v <= 31), `Invalid ${name}: ${v}. Use a day of the month, 1-31.`);
  const amount = (v: number | null | undefined, name: string) =>
    check(v == null || (Number.isFinite(v) && v >= 0), `Invalid ${name}: ${v}. Use a positive amount.`);
  const count = (v: number | null | undefined, name: string) =>
    check(v == null || (Number.isInteger(v) && v > 0 && v < 10000), `Invalid ${name}: ${v}. Use a whole number above 0.`);
  day(u.dueDay, 'due day');
  day(u.statementDay, 'statement day');
  check(u.kind === undefined || ['card', 'loan', 'bnpl'].includes(u.kind), `Invalid kind: ${u.kind}. Use card, loan or bnpl.`);
  amount(u.limit, 'limit');
  amount(u.emi, 'instalment');
  amount(u.principal, 'principal');
  check(u.rate == null || (Number.isFinite(u.rate) && u.rate >= 0 && u.rate <= 999), `Invalid rate: ${u.rate}. Use a yearly % between 0 and 999.`);
  check(u.rateType == null || u.rateType === 'fixed' || u.rateType === 'float', `Invalid rate type: ${u.rateType}. Use fixed or float.`);
  if (u.min && u.min.kind === 'percent') {
    check(u.min.percent > 0 && u.min.percent <= 100, `Invalid minimum: ${u.min.percent}%. Use a percentage above 0 and at most 100.`);
    amount(u.min.floor, 'minimum floor');
  }
  if (u.autopay && u.autopay.kind === 'fixed') amount(u.autopay.amount, 'autopay amount');
  check(u.region == null || /^[A-Za-z]{2}$/.test(u.region), `Invalid region: ${u.region}. Use a two-letter country code (IN, US, GB…).`);
  check(u.currency == null || /^[A-Za-z]{3}$/.test(u.currency), `Invalid currency: ${u.currency}. Use a three-letter ISO code.`);
  check(u.promoEnds == null || DAY.test(u.promoEnds), `Invalid promo end: ${u.promoEnds}. Use YYYY-MM-DD.`);
  check(
    u.loanKind == null || ['home', 'car', 'personal', 'education', 'other'].includes(u.loanKind),
    `Invalid loan kind: ${u.loanKind}. Use home, car, personal, education or other.`
  );
  check(u.start == null || MONTH.test(u.start), `Invalid start: ${u.start}. Use YYYY-MM.`);
  count(u.term, 'term');
  count(u.instalments, 'instalment count');
  check(u.every == null || ['1w', '2w', '1m'].includes(u.every), `Invalid spacing: ${u.every}. Use 1w, 2w or 1m.`);
  check(u.first == null || DAY.test(u.first), `Invalid first instalment: ${u.first}. Use YYYY-MM-DD.`);
}

/** Parse `5%`, `2%/200` (2%, at least 200 in major units) or `all` into the tag's rule. */
export function parseMinRule(text: string, toMinor: (major: number) => number): DebtTag['min'] {
  const t = text.trim().toLowerCase();
  if (t === 'all' || t === 'full') return { kind: 'all' };
  const m = /^(\d+(?:\.\d+)?)%(?:\/(\d+(?:\.\d+)?))?$/.exec(t);
  if (!m) throw new Error(`Invalid minimum rule: ${text}. Use 5%, 2%/200 (2%, at least 200) or all.`);
  return { kind: 'percent', percent: parseFloat(m[1]), floor: m[2] ? toMinor(parseFloat(m[2])) : null };
}

/** Parse `none`, `min`, `full` or `fixed/<major amount>`. */
export function parseAutopay(text: string, toMinor: (major: number) => number): DebtTag['autopay'] {
  const t = text.trim().toLowerCase();
  if (t === 'none' || t === 'min' || t === 'full') return { kind: t };
  const m = /^fixed\/(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) throw new Error(`Invalid autopay: ${text}. Use none, min, full or fixed/<amount>.`);
  return { kind: 'fixed', amount: toMinor(parseFloat(m[1])) };
}

const CLEARABLE: Record<string, keyof DebtTagUpdates> = {
  due: 'dueDay',
  statement_day: 'statementDay',
  limit: 'limit',
  rate: 'rate',
  rate_type: 'rateType',
  min: 'min',
  autopay: 'autopay',
  region: 'region',
  currency: 'currency',
  promo: 'promoEnds',
  loan_kind: 'loanKind',
  emi: 'emi',
  start: 'start',
  term: 'term',
  principal: 'principal',
  instalments: 'instalments',
  every: 'every',
  first: 'first',
};

/**
 * The tag updates in `arc debts set` / `arc_debts_set` arguments (snake_case
 * keys, CLI strings or MCP numbers; amounts in major units). Shared so both
 * surfaces read the same flags the same way.
 */
export function debtUpdatesFromArgs(args: Record<string, unknown>): DebtTagUpdates {
  const u: DebtTagUpdates = {};
  const has = (k: string) => args[k] !== undefined && args[k] !== null && args[k] !== '';
  const num = (k: string): number => {
    const n = typeof args[k] === 'number' ? (args[k] as number) : Number(String(args[k]).trim());
    if (!Number.isFinite(n)) throw new Error(`Invalid --${k.replace(/_/g, '-')}: ${String(args[k])}. Use a number.`);
    return n;
  };
  const int = (k: string): number => {
    const n = num(k);
    if (!Number.isInteger(n)) throw new Error(`Invalid --${k.replace(/_/g, '-')}: ${n}. Use a whole number.`);
    return n;
  };
  const str = (k: string) => String(args[k]).trim();
  const minor = (major: number) => Math.round(major * 100);
  if (has('kind')) u.kind = str('kind').toLowerCase() as DebtKind;
  if (has('due')) u.dueDay = int('due');
  if (has('statement_day')) u.statementDay = int('statement_day');
  if (has('limit')) u.limit = minor(num('limit'));
  if (has('rate')) u.rate = num('rate');
  if (has('rate_type')) u.rateType = str('rate_type').toLowerCase() as 'fixed' | 'float';
  if (has('min')) u.min = parseMinRule(str('min'), minor);
  if (has('autopay')) u.autopay = parseAutopay(str('autopay'), minor);
  if (has('region')) u.region = str('region').toUpperCase();
  if (has('currency')) u.currency = str('currency').toUpperCase();
  if (has('promo')) u.promoEnds = str('promo');
  if (has('loan_kind')) u.loanKind = str('loan_kind').toLowerCase() as DebtTag['loanKind'];
  if (has('emi')) u.emi = minor(num('emi'));
  if (has('start')) u.start = str('start');
  if (has('term')) u.term = int('term');
  if (has('principal')) u.principal = minor(num('principal'));
  if (has('instalments')) u.instalments = int('instalments');
  if (has('every')) u.every = str('every').toLowerCase() as DebtTag['every'];
  if (has('first')) u.first = str('first');
  if (has('clear')) {
    const list = Array.isArray(args.clear) ? (args.clear as unknown[]).map(String) : String(args.clear).split(',');
    for (const raw of list) {
      const key = raw.trim().replace(/-/g, '_');
      if (!key) continue;
      const field = CLEARABLE[key];
      if (!field) throw new Error(`Unknown field to clear: ${raw}. Use: ${Object.keys(CLEARABLE).join(', ')}.`);
      if (field in u) throw new Error(`--${key.replace(/_/g, '-')} is both set and cleared. Pick one.`);
      (u as Record<string, unknown>)[field] = field === 'autopay' ? { kind: 'none' } : null;
    }
  }
  return u;
}

/** `arc debts record` / `arc_debts_record` arguments as statement figures (decimals). */
export function statementFiguresFromArgs(args: Record<string, unknown>): StatementFigures {
  const out: StatementFigures = {};
  const num = (k: string): number | undefined => {
    if (args[k] === undefined || args[k] === null || args[k] === '') return undefined;
    const n = typeof args[k] === 'number' ? (args[k] as number) : Number(String(args[k]).trim());
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --${k.replace(/_/g, '-')}: ${String(args[k])}. Use a positive number.`);
    return n;
  };
  const day = (k: string): string | undefined => {
    if (args[k] === undefined || args[k] === null || args[k] === '') return undefined;
    const v = String(args[k]).trim();
    if (!DAY.test(v)) throw new Error(`Invalid --${k.replace(/_/g, '-')}: ${v}. Use YYYY-MM-DD.`);
    return v;
  };
  out.statementBalance = num('balance');
  out.minimumDue = num('minimum');
  out.dueDate = day('due_date');
  out.statementDate = day('statement_date');
  out.creditLimit = num('limit');
  out.availableLimit = num('available');
  out.previousBalance = num('previous');
  out.interestCharged = num('interest');
  out.fees = num('fees');
  out.outstanding = num('outstanding');
  out.principalPaid = num('principal_paid');
  out.interestPaid = num('interest_paid');
  if (args.currency) out.currency = String(args.currency).toUpperCase();
  for (const k of Object.keys(out) as Array<keyof StatementFigures>) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * Change some of the debt's details (DebtTagService.upsertDebtTag): the rest,
 * and fields a newer arc wrote, stay as they are. Every other line of the
 * account note survives. Clearing every field removes the line.
 */
export async function setDebt(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string,
  updates: DebtTagUpdates
): Promise<{ accountId: string; accountName: string; tagLine: string | null; tag: DebtTag | null }> {
  client.ensureConnected();
  validateDebtUpdates(updates);
  if (Object.keys(updates).length === 0) {
    throw new Error('Nothing to change. Pass at least one field, e.g. --due 5 or --limit 3000.');
  }
  const account = await findAccount(client, accountId);
  let tag: DebtTag | null = null;
  const next = await mutateNote(client, writer, `Set debt details: ${account.name}`, accountNoteId(account.id), (current) => {
    const held = parseDebtNote(current) ?? { ...EMPTY_DEBT_TAG, autopay: { kind: 'none' }, other: [] };
    const merged: DebtTag = { ...held, ...updates, other: held.other };
    if (merged.region) merged.region = merged.region.toUpperCase();
    if (merged.currency) merged.currency = merged.currency.toUpperCase();
    tag = isEmptyDebtTag(merged) ? null : merged;
    return noteWithDebtTag(current, merged) ?? '';
  });
  return { accountId: account.id, accountName: account.name, tagLine: findDebtLine(next), tag };
}

/**
 * Stop treating an account as a debt: removes the `#debt|` line. The
 * account, its balance, its transactions and its cycle records are untouched.
 */
export async function clearDebt(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string
): Promise<{ accountId: string; accountName: string; removed: boolean }> {
  client.ensureConnected();
  const account = await findAccount(client, accountId);
  let removed = false;
  await mutateNote(client, writer, `Clear debt: ${account.name}`, accountNoteId(account.id), (current) => {
    removed = findDebtLine(current) !== null;
    // Nothing to remove: leave the note exactly as it is.
    return removed ? noteWithDebtTag(current, null) ?? '' : current ?? '';
  });
  return { accountId: account.id, accountName: account.name, removed };
}

// ── cycle records ───────────────────────────────────────────────────────────

/**
 * Keep a statement's figures on the debt's cycle (DebtCycleService.recordStatement).
 * Field by field, typed beats import beats capture. A statement with no due
 * date is filed under the due date after its statement date (the tag's due
 * day); with neither, only an available limit is kept, beside the cycles.
 * Figures are decimals in the statement's currency.
 */
export async function recordDebtStatement(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string,
  figures: StatementFigures,
  source: CycleSource = 'typed',
  now: Date = new Date()
): Promise<{ accountId: string; accountName: string; recorded: 'cycle' | 'latest'; due: string | null; cycle: DebtCycleRecord | null }> {
  client.ensureConnected();
  const account = await findAccount(client, accountId);
  const budget = await readBudget(client);
  const tag = tagOf(budget, account.id);
  const plan = planStatement(figures, tag, cardCurrencyOf(tag, account.id, budget.ctx), localDay(now));
  if (plan.kind === 'nothing') {
    throw new Error(
      tag?.dueDay == null && !figures.dueDate && figures.availableLimit == null
        ? `Nothing to keep: ${account.name} has no due day, so the figures have no cycle. Pass --due-date, or set one with \`arc debts set --due <day>\`.`
        : 'Nothing to keep: pass at least one figure (--balance, --minimum, --limit, --available, …), in the debt\'s own currency.'
    );
  }
  const at = now.getTime();
  let cycle: DebtCycleRecord | null = null;
  await mutateNote(client, writer, `Record debt statement: ${account.name}`, debtCyclesNoteId(account.id), (current) => {
    const cycles = parseDebtCycles(current);
    const latest = parseLatestLimit(current);
    if (plan.kind === 'latest') {
      const next = newerLatestLimit(latest, plan.avail, plan.day, source, at);
      return encodeDebtCycles(cycles, next ?? latest) ?? '';
    }
    const merged = mergeDebtCycle(cycles, plan.update, source, at);
    cycle = merged.find((c) => c.due === plan.update.due) ?? null;
    return encodeDebtCycles(merged, latest) ?? '';
  });
  return {
    accountId: account.id,
    accountName: account.name,
    recorded: plan.kind,
    due: plan.kind === 'cycle' ? plan.update.due : null,
    cycle,
  };
}

/** "Already paid? Mark as paid", and taking it back (`paid: false`). Defaults to the cycle being judged now. */
export async function markDebtPaid(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string,
  options: { due?: string; paid?: boolean } = {},
  now: Date = new Date()
): Promise<{ accountId: string; accountName: string; due: string; paid: boolean; state: string | null }> {
  client.ensureConnected();
  const account = await findAccount(client, accountId);
  let due = options.due;
  if (due !== undefined) check(DAY.test(due), `Invalid due date: ${due}. Use YYYY-MM-DD.`);
  if (!due) {
    const shown = await showDebt(client, account.id, now);
    due = shown.cycle?.dueDate ?? undefined;
    if (!due) throw new Error(`${account.name} has no due date. Pass --due YYYY-MM-DD, or set a due day with \`arc debts set --due <day>\`.`);
  }
  const paid = options.paid !== false;
  await mutateNote(client, writer, `${paid ? 'Mark' : 'Unmark'} debt cycle paid: ${account.name}`, debtCyclesNoteId(account.id), (current) => {
    const merged = mergeDebtCycle(parseDebtCycles(current), { due: due!, marked: paid ? 'paid' : null }, 'typed', now.getTime());
    return encodeDebtCycles(merged, parseLatestLimit(current)) ?? '';
  });
  const after = await showDebt(client, account.id, now).catch(() => null);
  return { accountId: account.id, accountName: account.name, due, paid, state: after?.cycle?.state ?? null };
}

// ── payoff and plan ─────────────────────────────────────────────────────────

/**
 * What paying this debt off takes: at the payment in hand (or `payment`), with
 * `extra` more each month, or after a one-off `lump`. Card currency, minor units.
 */
export async function simulatePayoff(
  client: ActualClient,
  accountId: string,
  options: { payment?: number; extra?: number; lump?: number; rate?: number } = {},
  now: Date = new Date()
) {
  const shown = await showDebt(client, accountId, now);
  const owed = shown.owedCard;
  if (owed == null) throw new Error(`${shown.accountName} is in ${shown.currency} and arc has no rate to reach it. Add an FX rule for the account first.`);
  const rate = options.rate ?? shown.tag?.rate ?? null;
  const payment = options.payment ?? shown.payoff?.payment ?? null;
  if (!payment) throw new Error('No payment to work from. Pass --payment, or set a minimum rule or instalment with `arc debts set`.');
  const today = localDay(now);
  const settled = shown.cycle?.state === 'paid' || shown.cycle?.state === 'nothing_due';
  const first = nextPaymentDay(shown.cycle?.dueDate, settled, today);
  const run = payoffRun(owed, rate ?? 0, payment);
  const more = options.extra ? payMore(owed, rate ?? 0, payment, options.extra) : null;
  const once = options.lump ? prepay(owed, rate ?? 0, payment, options.lump) : null;
  return {
    accountId: shown.accountId,
    accountName: shown.accountName,
    currency: shown.currency,
    owed,
    rate,
    rateKnown: rate != null,
    payment,
    run: run ? { ...run, payoffMonth: payoffMonth(first, run.months) } : null,
    neverClears: run == null && owed > 0,
    payMore: more ? { extra: options.extra, ...more, payoffMonth: payoffMonth(first, more.more.months) } : null,
    prepay: once ? { lump: options.lump, ...once } : null,
  };
}

/**
 * "Pay here first": every debt pays its minimum each month; spare money (and
 * what a cleared debt was paying) goes to one debt at a time. Avalanche ranks
 * by rate (needs every rate), snowball by size. Budget currency.
 */
export async function payoffPlanFor(
  client: ActualClient,
  options: { extra?: number; method?: PlanMethod } = {},
  now: Date = new Date()
) {
  const budget = await readBudget(client);
  const { debts } = await classifyAll(client, budget, now);
  const today = localDay(now);
  const owing = debts.filter((d) => d.summary.owedBook > 0);
  const planned = owing.map((d) => ({ ...planDebtOf({ id: d.account.id, summary: d.summary }), name: d.account.name }));
  const nameOf = new Map(planned.map((p) => [p.id, p.name]));
  const ratesKnown = planned.every((p) => p.ratePct != null);
  const first = firstDueOf(owing.map((d) => d.summary), today);
  const run = (method: PlanMethod) => {
    if (method === 'avalanche' && !ratesKnown) {
      return { method, available: false as const, reason: 'Avalanche needs every debt\'s rate. Set them with `arc debts set --rate`.' };
    }
    const plan = payoffPlan(planned, method, options.extra ?? 0);
    if (!plan) return { method, available: false as const, reason: 'The minimums never clear these debts.' };
    return {
      method,
      available: true as const,
      first: { accountId: plan.first, accountName: nameOf.get(plan.first) ?? plan.first },
      order: plan.order.map((id) => ({ accountId: id, accountName: nameOf.get(id) ?? id })),
      months: plan.months,
      interest: plan.interest,
      debtFreeMonth: payoffMonth(first, plan.months),
    };
  };
  const methods: PlanMethod[] = options.method ? [options.method] : ['avalanche', 'snowball'];
  return {
    // The app shows it with two or more debts owing.
    debtsOwing: planned.length,
    extra: options.extra ?? 0,
    monthlyTotal: planned.reduce((sum, p) => sum + p.minimum, 0) + (options.extra ?? 0),
    debts: planned.map((p) => ({ accountId: p.id, accountName: p.name, owed: p.owed, rate: p.ratePct, minimum: p.minimum, minimumEstimated: p.estimated })),
    plans: planned.length ? methods.map(run) : [],
  };
}
