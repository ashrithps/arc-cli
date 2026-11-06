/**
 * Statements — what the arc app (1.0.50+) keeps about each statement it has
 * filed for an account: the figures, whether it reconciled with the bank,
 * the undo journal, the cycle it learned, the payment due on a card, and the
 * fees of the last 12 months with the late fees worth asking back.
 *
 * Where it lives (budgetarc docs/specs/debt-cycle.md §9):
 *   arc-statements:<accountId>   JSON (src/codecs/statement-checkpoints.ts),
 *                                newest 13 statements, the learned cycle,
 *                                dates ahead, the auto-file switch, …
 *
 * Statement *filing* (reading a PDF, matching rows, adding the missing ones)
 * happens on the phone; so does undo, and so do the PDF passwords, which live
 * only in the phone's Keychain and are never read or written here. The CLI
 * reads the record, and writes only the two switches that are plain note
 * fields: the per-account auto-file switch and "not this one" on a fee.
 *
 * Every rule that decides a figure is in src/codecs/statement-*.ts, ported
 * near-verbatim. Writes are read-modify-write inside the SafeWriter callback
 * (`mutateNote`) and keep every field this CLI does not model, so a record a
 * newer app wrote survives a write from here.
 *
 * Amounts are integer minor units of the statement's currency, signed as
 * Actual stores the balance (a card that owes is negative). Fee and payment
 * figures are positive.
 */
import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import {
  STATEMENTS_NOTE_PREFIX,
  emptyStatementsRecord,
  encodeStatementsRecord,
  learnedFields,
  parseStatementsRecord,
  statementsNoteId,
  type StatementCheckpoint,
  type StatementsRecord,
} from '../codecs/statement-checkpoints.js';
import { cardPaymentDue, learnedDueFor, type CardPaymentDue } from '../codecs/statement-card-payment.js';
import { cycleFromRecord, missingStatement, projectedDates, type ProjectedDate } from '../codecs/statement-projections.js';
import { feeLedger, isCardPayment, worthAskingBack, type AskBack, type FeeLedger, type FeeRow } from '../codecs/statement-fees.js';
import { transactionSig, undoPreview, type UndoPreview } from '../codecs/statement-undo.js';
import { accountTypeKey } from '../codecs/debt-accounts.js';
import { parseDebtNote } from '../codecs/debt-tag.js';
import { addDays, localDay } from '../codecs/debt-cycle.js';
import { getScheduleAmountCents } from '../codecs/schedule-amount.js';
import { accountNoteId, mutateNote, readAllNotes, readNote } from './notes.js';
import { validateId } from '../utils/validation.js';

// ── Reading the budget ──────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  name: string;
  type?: string | null;
  closed?: boolean;
}

/** The app's FilingAccount (services/statements/budgetFilingStore.ts filingAccountFor), currency rule left out as the app passes null. */
interface FilingAccount {
  id: string;
  name: string;
  isCard: boolean;
  isLoan: boolean;
  isDebt: boolean;
  currency: string | null;
}

interface Row {
  id: string;
  date: string;
  amount: number;
  notes: string | null;
  imported_payee: string | null;
  payee: string | null;
  category: string | null;
  account: string;
  transfer_id: string | null;
}

interface Ctx {
  accounts: AccountRow[];
  noteById: Map<string, string>;
  payees: Map<string, { name: string; transferAcct: string | null }>;
}

async function readCtx(client: ActualClient): Promise<Ctx> {
  client.ensureConnected();
  const [accounts, notes, payees] = await Promise.all([
    client.api.getAccounts() as Promise<any[]>,
    readAllNotes(client),
    client.api.getPayees() as Promise<any[]>,
  ]);
  return {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type ?? null, closed: !!a.closed })),
    noteById: new Map(notes.map((n) => [n.id, n.note])),
    payees: new Map((payees ?? []).map((p: any) => [p.id, { name: p.name ?? '', transferAcct: p.transfer_acct ?? null }])),
  };
}

function filingAccountFor(ctx: Ctx, accountId: string): FilingAccount | null {
  const account = ctx.accounts.find((a) => a.id === accountId);
  if (!account) return null;
  const isCard = accountTypeKey(account) === 'credit';
  const isLoan = accountTypeKey(account) === 'mortgage';
  const tag = parseDebtNote(ctx.noteById.get(accountNoteId(accountId)) ?? null);
  return { id: account.id, name: account.name, isCard, isLoan, isDebt: isCard || isLoan || !!tag, currency: tag?.currency ?? null };
}

function recordOf(ctx: Ctx, accountId: string): StatementsRecord {
  return parseStatementsRecord(ctx.noteById.get(statementsNoteId(accountId)) ?? null);
}

/**
 * The account's rows between two days, as the app's
 * findTransactionsByAccountAndDateRange: split parents, never their lines.
 */
async function rowsBetween(client: ActualClient, accountId: string, start: string, end: string): Promise<Row[]> {
  const res: any = await client.api.aqlQuery(
    client.api
      .q('transactions')
      .filter({ account: accountId, $and: [{ date: { $gte: start } }, { date: { $lte: end } }] })
      .options({ splits: 'none' })
      .select(['id', 'date', 'amount', 'notes', 'imported_payee', 'payee', 'category', 'account', 'transfer_id'])
  );
  return ((res?.data ?? []) as Row[]).map((r) => ({ ...r, amount: r.amount ?? 0 }));
}

/** Rows by id, any account, split lines included (a filed row can be either). */
async function rowsById(client: ActualClient, ids: string[]): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const res: any = await client.api.aqlQuery(
      client.api
        .q('transactions')
        .filter({ id: { $oneof: chunk } })
        .options({ splits: 'all' })
        .select(['id', 'date', 'amount', 'notes', 'imported_payee', 'payee', 'category', 'account', 'transfer_id'])
    );
    for (const r of (res?.data ?? []) as Row[]) out.set(r.id, r);
  }
  return out;
}

function payeeName(ctx: Ctx, row: Row): string | null {
  return row.payee ? ctx.payees.get(row.payee)?.name ?? null : null;
}

// ── Shapes returned ─────────────────────────────────────────────────────────

export interface LearnedCycleView {
  statementDay: number;
  /** "day 5" (the 5th of the month) or "20 days after" (the statement). */
  due: { kind: 'day'; day: number } | { kind: 'offset'; days: number } | null;
  weekend: 'next_business_day' | 'previous_business_day' | 'none';
}

export interface StatementView {
  start: string | null;
  end: string;
  currency: string | null;
  opening: number | null;
  closing: number | null;
  interestEarned: number | null;
  interestCharged: number | null;
  fees: number | null;
  /** typed | import (filed from a statement) | capture (read from a text). */
  source: StatementCheckpoint['src'];
  /** Whether the balance matched the bank's as of the statement's own date, and by how much it was off. */
  reconciled: { state: 'matches' | 'off'; diff: number; at: string | null } | null;
  filedAt: string | null;
  /** The first 12 characters of the document's sha256 (the PDF or email body). */
  document: string | null;
  /** The undo journal: what this filing wrote. */
  rows: { added: number; cleared: number; locked: number; updated: number; linked: number };
  /** How each added row got its category. */
  categorised: { rule: number; history: number; none: number };
}

export interface PaymentDue extends CardPaymentDue {
  accountId: string;
  accountName: string;
  currency: string | null;
  /** The account the card was paid from last time; null when arc hasn't seen a payment. */
  payFrom: { id: string; name: string } | null;
}

export interface StatementAccountItem {
  accountId: string;
  accountName: string;
  kind: 'card' | 'loan' | 'account';
  closed: boolean;
  /** Statements file on their own (the per-account switch, Settings › Statements). */
  autoFile: boolean;
  statements: number;
  newest: { end: string; closing: number | null; currency: string | null; source: string; reconciled: 'matches' | 'off' | null; offBy: number | null } | null;
  learned: LearnedCycleView | null;
  /** The next statement that should have arrived and hasn't (five days gone). */
  missing: string | null;
  paymentDue: PaymentDue | null;
}

export interface AccountFees {
  accountId: string;
  accountName: string;
  /** Null on a card or loan: its debt view already shows interest and fees for the year (`arc debts show`). */
  ledger: FeeLedger | null;
  /** Late fees worth asking the bank to take back, newest first. */
  asks: Array<AskBack & { text: string }>;
  currency: string | null;
}

export interface StatementAccountDetail extends Omit<StatementAccountItem, 'newest'> {
  statementsList: Array<StatementView & { undo: UndoPreview | null }>;
  /** Card fields arc filled from statements (rate, min, limit…), shown as "learned" on the phone. */
  learnedFields: string[];
  projected: ProjectedDate[];
  dates: StatementsRecord['dates'] | null;
  /** The card's usual markup on foreign purchases, learned from statements (0.035 = 3.5%). */
  fxMarkup: { markup: number; statements: number } | null;
  /** A loan's next instalments from its statement: [date, principal, interest] in minor units. */
  loanSchedule: Array<{ date: string; principal: number; interest: number }>;
  fees: AccountFees | null;
  /** Late fees you said aren't worth asking back. */
  feesDismissed: string[];
  counts: { payeeNames: number; transferRoutes: number; notDuplicates: number; balanceAnchors: number };
}

function learnedView(record: StatementsRecord): LearnedCycleView | null {
  if (!record.learned) return null;
  const c = cycleFromRecord(record.learned);
  return { statementDay: c.statementDay, due: c.due, weekend: c.weekend };
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);

function statementView(s: StatementCheckpoint): StatementView {
  const how = { rule: 0, history: 0, none: 0 };
  for (const v of Object.values(s.how ?? {})) how[v]++;
  return {
    start: s.start ?? null,
    end: s.end,
    currency: s.cur ?? null,
    opening: s.open ?? null,
    closing: s.close ?? null,
    interestEarned: s.intEarned ?? null,
    interestCharged: s.intCharged ?? null,
    fees: s.fees ?? null,
    source: s.src,
    reconciled: s.matched ? { state: s.matched.state, diff: s.matched.diff, at: iso(s.matched.at) } : null,
    filedAt: iso(s.at),
    document: s.doc ? s.doc.slice(0, 12) : null,
    rows: {
      added: s.added?.length ?? 0,
      cleared: s.cleared?.length ?? 0,
      locked: s.locked?.length ?? 0,
      updated: s.updated?.length ?? 0,
      linked: s.linked?.length ?? 0,
    },
    categorised: how,
  };
}

function kindOf(a: FilingAccount): StatementAccountItem['kind'] {
  return a.isCard ? 'card' : a.isLoan ? 'loan' : 'account';
}

/** A record worth listing: a statement, or a switch / learned cycle on its own. */
function hasContent(record: StatementsRecord): boolean {
  return encodeStatementsRecord(record) !== null;
}

// ── The card payment (services/statements/statementUpcoming.ts) ─────────────

/** Does a live schedule already pay this card (on the card, or a transfer to it)? */
async function hasPaymentSchedule(client: ActualClient, ctx: Ctx, accountId: string): Promise<boolean> {
  let schedules: any[] = [];
  try {
    schedules = (await client.api.getSchedules()) as any[];
  } catch {
    return false;
  }
  // transferPayeeIdFor: the lowest id among the account's transfer payees.
  const payee = [...ctx.payees.entries()].filter(([, p]) => p.transferAcct === accountId).map(([id]) => id).sort()[0] ?? null;
  return schedules.some((s) => !s.completed && !s.tombstone && (
    (s.account === accountId && (getScheduleAmountCents(s.amount) ?? 0) > 0) || (!!payee && s.payee === payee)
  ));
}

/** The other account of the newest payment into the card, in the last 120 days. */
function lastPayer(ctx: Ctx, rows: Row[], today: string): { id: string; name: string } | null {
  const from = addDays(today, -120);
  const ins = rows
    .filter((r) => r.date >= from && r.date <= today && r.amount > 0 && r.transfer_id)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const r of ins) {
    const other = r.payee ? ctx.payees.get(r.payee)?.transferAcct : null;
    const account = other ? ctx.accounts.find((a) => a.id === other && !a.closed) : undefined;
    if (account) return { id: account.id, name: account.name };
  }
  return null;
}

async function paymentDueFor(
  client: ActualClient,
  ctx: Ctx,
  account: FilingAccount,
  record: StatementsRecord,
  today: string,
  rows: Row[],
): Promise<PaymentDue | null> {
  if (!account.isCard) return null;
  const latest = record.stmts[record.stmts.length - 1];
  if (!latest || (await hasPaymentSchedule(client, ctx, account.id))) return null;
  const from = addDays(latest.end, 1);
  const paidBetween = (a: string, b: string) => rows
    .filter((r) => r.date >= a && r.date <= b && r.amount > 0)
    .reduce((sum, r) => sum + r.amount, 0);
  const paid = today < from ? 0 : paidBetween(from, today);
  const due = cardPaymentDue(record, today, paid, paidBetween);
  if (!due) return null;
  return { ...due, accountId: account.id, accountName: account.name, currency: latest.cur ?? account.currency ?? null, payFrom: lastPayer(ctx, rows, today) };
}

// ── Fees (services/statements/statementFeesService.ts) ──────────────────────

function feesFor(ctx: Ctx, account: FilingAccount, record: StatementsRecord, rows: Row[], today: string): AccountFees | null {
  const filed = record.stmts.filter((s) => s.src === 'import');
  if (!filed.length) return null;
  const feeRows: FeeRow[] = rows
    .filter((r) => r.date >= addDays(today, -400) && r.date <= today)
    .map((r) => ({ id: r.id, date: r.date, amount: r.amount, text: r.imported_payee || payeeName(ctx, r) || r.notes || '' }));
  const ledger = feeLedger(feeRows, today, account.isCard);
  const currency = filed[filed.length - 1].cur ?? account.currency ?? null;
  const asks = account.isCard
    ? worthAskingBack({
      rows: feeRows,
      payments: feeRows.filter(isCardPayment).map((r) => ({ date: r.date, amount: r.amount })),
      statements: filed.map((s) => ({ end: s.end, due: learnedDueFor(record, s.end)?.due ?? null, owed: s.close !== undefined ? -s.close : 0 })),
      currency,
      today,
      dismissed: record.feesOk,
    })
    : [];
  const shown = account.isDebt || !ledger.count ? null : ledger;
  if (!shown && !asks.length) return null;
  const text = new Map(feeRows.map((r) => [r.id, r.text]));
  return { accountId: account.id, accountName: account.name, ledger: shown, asks: asks.map((a) => ({ ...a, text: text.get(a.feeId) ?? '' })), currency };
}

/** Rows the reads need: 400 days for fees, which covers 120 for the payer. */
const ROW_DAYS = 400;

// ── Public reads ────────────────────────────────────────────────────────────

async function itemFor(client: ActualClient, ctx: Ctx, account: AccountRow, record: StatementsRecord, today: string): Promise<{ item: StatementAccountItem; rows: Row[]; filing: FilingAccount }> {
  const filing = filingAccountFor(ctx, account.id)!;
  const rows = await rowsBetween(client, account.id, addDays(today, -ROW_DAYS), today);
  const newest = record.stmts[record.stmts.length - 1] ?? null;
  return {
    filing,
    rows,
    item: {
      accountId: account.id,
      accountName: account.name,
      kind: kindOf(filing),
      closed: !!account.closed,
      autoFile: record.manual !== true,
      statements: record.stmts.length,
      newest: newest
        ? {
          end: newest.end,
          closing: newest.close ?? null,
          currency: newest.cur ?? null,
          source: newest.src,
          reconciled: newest.matched?.state ?? null,
          offBy: newest.matched?.state === 'off' ? newest.matched.diff : null,
        }
        : null,
      learned: learnedView(record),
      missing: missingStatement(record, today),
      paymentDue: await paymentDueFor(client, ctx, filing, record, today, rows),
    },
  };
}

/** Every account with a statements record, payments due first, then by name. */
export async function listStatements(client: ActualClient, now: Date = new Date()): Promise<StatementAccountItem[]> {
  const ctx = await readCtx(client);
  const today = localDay(now);
  const out: StatementAccountItem[] = [];
  for (const [id, note] of ctx.noteById) {
    if (!id.startsWith(STATEMENTS_NOTE_PREFIX)) continue;
    const account = ctx.accounts.find((a) => a.id === id.slice(STATEMENTS_NOTE_PREFIX.length));
    const record = parseStatementsRecord(note);
    if (!account || !hasContent(record)) continue;
    out.push((await itemFor(client, ctx, account, record, today)).item);
  }
  return out.sort((a, b) => {
    const da = a.paymentDue?.due ?? '9999';
    const db = b.paymentDue?.due ?? '9999';
    if (da !== db) return da < db ? -1 : 1;
    return a.accountName.localeCompare(b.accountName);
  });
}

async function accountOf(ctx: Ctx, accountId: string): Promise<AccountRow> {
  validateId(accountId);
  const account = ctx.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);
  return account;
}

/** One account's statements in full: figures, reconciliation, the undo journal, the cycle and dates ahead, fees. */
export async function showStatements(client: ActualClient, accountId: string, now: Date = new Date()): Promise<StatementAccountDetail> {
  const ctx = await readCtx(client);
  const account = await accountOf(ctx, accountId);
  const today = localDay(now);
  const record = recordOf(ctx, account.id);
  const { item, rows, filing } = await itemFor(client, ctx, account, record, today);
  const { newest: _newest, ...rest } = item;
  // Each filing's fingerprints now, for what undo would take back and keep.
  const sigIds = [...new Set(record.stmts.flatMap((s) => Object.keys(s.sigs ?? {})))];
  const byId = await rowsById(client, sigIds);
  const sigsNow: Record<string, string | null> = {};
  for (const id of sigIds) {
    const r = byId.get(id);
    sigsNow[id] = r ? transactionSig(r) : null;
  }
  return {
    ...rest,
    statementsList: record.stmts.map((s) => ({
      ...statementView(s),
      undo: s.src === 'import' ? undoPreview(s, s.sigs ? sigsNow : null) : null,
    })),
    learnedFields: learnedFields(record),
    projected: projectedDates(record, today),
    dates: record.dates ?? null,
    fxMarkup: record.fx ? { markup: record.fx.markup, statements: record.fx.n } : null,
    loanSchedule: (record.loanSched ?? []).map(([date, principal, interest]) => ({ date, principal, interest })),
    fees: feesFor(ctx, filing, record, rows, today),
    feesDismissed: record.feesOk ?? [],
    counts: {
      payeeNames: Object.keys(record.aliases ?? {}).length,
      transferRoutes: Object.keys(record.routes ?? {}).length,
      notDuplicates: record.notDup.length,
      balanceAnchors: record.anchors.length,
    },
  };
}

/** Fees of the last 12 months and late fees worth asking back: one account, or every account with a statement filed. */
export async function statementFees(client: ActualClient, accountId?: string, now: Date = new Date()): Promise<AccountFees[]> {
  const ctx = await readCtx(client);
  const today = localDay(now);
  const ids = accountId
    ? [(await accountOf(ctx, accountId)).id]
    : ctx.accounts.filter((a) => !a.closed && recordOf(ctx, a.id).stmts.some((s) => s.src === 'import')).map((a) => a.id);
  const out: AccountFees[] = [];
  for (const id of ids) {
    const filing = filingAccountFor(ctx, id)!;
    const rows = await rowsBetween(client, id, addDays(today, -ROW_DAYS), today);
    const fees = feesFor(ctx, filing, recordOf(ctx, id), rows, today);
    if (fees) out.push(fees);
  }
  return out;
}

// ── Writes: two plain fields of the record ──────────────────────────────────

/** The record's fields this CLI knows; anything else is a newer app's and is kept as it is. */
const KNOWN_KEYS = new Set(['v', 'stmts', 'anchors', 'notDup', 'learned', 'fx', 'dates', 'aliases', 'feesOk', 'manual', 'wrote', 'loanSched', 'routes']);

/**
 * Change one top-level field of the statements note. A missing or unreadable
 * note is written the way the app writes one (parse → change → encode); an
 * existing one is changed in place, so every other field (including ones a
 * newer app wrote, at any depth) is kept byte for byte. A record left with
 * nothing in it is emptied, as the app writes null.
 */
export function patchStatementsNote(
  current: string | null,
  change: (fields: Record<string, unknown>, record: StatementsRecord) => void,
): string {
  let raw: unknown = null;
  try {
    raw = current ? JSON.parse(current) : null;
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const record = current ? parseStatementsRecord(current) : emptyStatementsRecord();
    const fields = record as unknown as Record<string, unknown>;
    change(fields, record);
    return encodeStatementsRecord(record) ?? '';
  }
  const fields = raw as Record<string, unknown>;
  change(fields, parseStatementsRecord(current));
  const text = JSON.stringify(fields);
  const foreign = Object.keys(fields).some((k) => !KNOWN_KEYS.has(k));
  return !foreign && encodeStatementsRecord(parseStatementsRecord(text)) === null ? '' : text;
}

/** setAccountAutoFile: on removes `manual`, off sets it. */
export function noteWithAutoFile(current: string | null, auto: boolean): string {
  return patchStatementsNote(current, (fields) => {
    if (auto) delete fields.manual;
    else fields.manual = true;
  });
}

/** dismissFeeAsk: the fee goes to the end of `feesOk` (the newest 40 kept). */
export function noteWithFeeDismissed(current: string | null, feeId: string): string {
  return patchStatementsNote(current, (fields, record) => {
    fields.feesOk = [...(record.feesOk ?? []).filter((id) => id !== feeId), feeId].slice(-40);
  });
}

/**
 * Settings › Statements, per account: whether its statements file on their
 * own. Off, a statement that adds up still waits on the phone for a look. The
 * choice is in the budget, so every phone on it follows.
 */
export async function setStatementAutoFile(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string,
  auto: boolean,
): Promise<{ accountId: string; accountName: string; autoFile: boolean; changed: boolean }> {
  const ctx = await readCtx(client);
  const account = await accountOf(ctx, accountId);
  if (account.closed) throw new Error(`${account.name} is closed: its statements don't file.`);
  let changed = false;
  await mutateNote(client, writer, `Statements ${auto ? 'file on their own' : 'wait for a look'}: ${account.name}`, statementsNoteId(account.id), (current) => {
    const next = noteWithAutoFile(current, auto);
    changed = next !== (current ?? '');
    return next;
  });
  return { accountId: account.id, accountName: account.name, autoFile: auto, changed };
}

/**
 * "Not this one": a late fee worth asking back is not suggested again, on
 * any phone. Only a fee arc is suggesting now can be dismissed.
 */
export async function dismissStatementFee(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string,
  feeId: string,
  now: Date = new Date(),
): Promise<{ accountId: string; accountName: string; feeId: string; dismissed: true }> {
  const fees = (await statementFees(client, accountId, now))[0];
  const ask = fees?.asks.find((a) => a.feeId === feeId);
  if (!ask) {
    const open = fees?.asks.map((a) => `${a.feeId} (${a.date})`).join(', ');
    throw new Error(open
      ? `${feeId} is not a fee arc suggests asking back on this account. Suggested now: ${open}.`
      : 'arc suggests no fee to ask back on this account, so there is nothing to dismiss.');
  }
  await mutateNote(client, writer, `Dismiss fee suggestion: ${fees.accountName}`, statementsNoteId(accountId), (current) =>
    noteWithFeeDismissed(current, feeId));
  return { accountId, accountName: fees.accountName, feeId, dismissed: true };
}

/** For tests and the parity record: the raw note, read the way the writes read it. */
export async function readStatementsNote(client: ActualClient, accountId: string): Promise<string | null> {
  return readNote(client, statementsNoteId(accountId));
}
