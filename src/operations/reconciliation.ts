import * as fs from 'fs';
import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import type { TransactionCreate } from '../types.js';
import { makeImportedId } from '../utils/imported-id.js';
import { validateDate, validateId, validateTransaction } from '../utils/validation.js';
import { getAccountFxMap } from './fx.js';
import {
  buildReconcileAdjustment,
  clearedBalanceOf,
  compareCentsToClearedBalance,
  looselyParseAmount,
  type ReconcileAdjustment,
} from '../reconcile/account.js';
import {
  flattenLedger,
  inMemoryLedger,
  nameMap,
  type ApiTransactionLike,
  type DBTransaction,
  type LedgerSource,
} from '../reconcile/adapter.js';
import { checkForDuplicates, findLedgerDuplicates } from '../reconcile/duplicates.js';
import {
  compareStatementBalances,
  findStatementReconciliations,
  type AccountInfo,
  type CurrencyRule,
  type ImportedStatementTransaction,
  type StatementBalanceComparison,
  type StatementReconciliationMatch,
} from '../reconcile/statement.js';

// ── Statement input ─────────────────────────────────────────────────────────

/** One statement line. `amount` is SIGNED MINOR UNITS from the account holder's side: negative = money out. */
export interface StatementLine {
  date: string;
  amount: number;
  payee?: string;
  description?: string;
  /** The bank's own id for the line (FITID, reference). Makes re-imports dedupe exactly. */
  id?: string;
}

export interface ParsedStatement {
  lines: StatementLine[];
  /** Minor units, when the file states them. */
  openingBalance?: number;
  closingBalance?: number;
}

export type StatementDateFormat = 'ymd' | 'dmy' | 'mdy';

export interface StatementParseOptions {
  /** How to read `03/04/2026`. Detected from the file when every date agrees; required when it can't be. */
  dateFormat?: StatementDateFormat;
  /** Flip every amount. For card statements that print purchases as positive. */
  invert?: boolean;
}

/** A line as MCP sends it: amounts in MAJOR units. */
export interface MajorUnitStatementLine {
  date: string;
  amount: number;
  payee?: string;
  description?: string;
  id?: string;
}

/** MCP / JSON lines (major units) → `StatementLine` (minor units). */
export function linesFromMajorUnits(lines: MajorUnitStatementLine[]): StatementLine[] {
  return lines.map((l, i) => {
    if (typeof l.amount !== 'number' || !Number.isFinite(l.amount)) {
      throw new Error(`Statement line ${i + 1}: amount must be a number, got "${l.amount}".`);
    }
    return {
      date: validateDate(l.date),
      amount: Math.round(l.amount * 100),
      ...(l.payee ? { payee: String(l.payee) } : {}),
      ...(l.description ? { description: String(l.description) } : {}),
      ...(l.id != null && l.id !== '' ? { id: String(l.id) } : {}),
    };
  });
}

const HEADER_ALIASES: Record<'date' | 'amount' | 'debit' | 'credit' | 'payee' | 'description' | 'id', string[]> = {
  date: ['date', 'transaction date', 'posting date', 'posted date', 'posted', 'booking date', 'value date', 'txn date', 'trans date'],
  amount: ['amount', 'value', 'amt', 'transaction amount'],
  debit: ['debit', 'debits', 'withdrawal', 'withdrawals', 'money out', 'paid out', 'debit amount', 'out'],
  credit: ['credit', 'credits', 'deposit', 'deposits', 'money in', 'paid in', 'credit amount', 'in'],
  payee: ['payee', 'merchant', 'name', 'counterparty', 'beneficiary', 'payee name'],
  description: ['description', 'details', 'memo', 'narrative', 'narration', 'particulars', 'reference text', 'transaction details'],
  id: ['id', 'fitid', 'transaction id', 'reference', 'ref', 'reference number'],
};

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function detectDelimiter(line: string): string {
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    let count = 0;
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/** RFC 4180 rows: quoted fields may hold the delimiter, newlines and `""` escapes. */
export function parseCsvRows(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const d = delimiter ?? detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === d) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

const ISO_DATE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/;
const SHORT_DATE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function buildIsoDate(y: number, m: number, d: number, raw: string): string {
  const year = y < 100 ? 2000 + y : y;
  const iso = `${year}-${pad2(m)}-${pad2(d)}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (m < 1 || m > 12 || d < 1 || d > 31 || isNaN(check.getTime()) || check.getUTCDate() !== d) {
    throw new Error(`Invalid date "${raw}".`);
  }
  return iso;
}

/**
 * Decide `dmy` vs `mdy` from the dates themselves: a first part over 12 can
 * only be a day, a second part over 12 only a day. Refuses rather than
 * guessing when every date is ambiguous or the file disagrees with itself.
 */
function resolveDateFormat(raws: string[], given?: StatementDateFormat): StatementDateFormat {
  if (given) return given;
  let dmy = false;
  let mdy = false;
  let short = false;
  for (const raw of raws) {
    const m = raw.trim().match(SHORT_DATE);
    if (!m) continue;
    short = true;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  if (!short) return 'ymd';
  if (dmy && mdy) throw new Error('Statement dates disagree on day/month order. Pass --date-format dmy or mdy.');
  if (dmy) return 'dmy';
  if (mdy) return 'mdy';
  throw new Error('Cannot tell whether statement dates are day/month or month/day. Pass --date-format dmy or mdy.');
}

function parseStatementDate(raw: string, format: StatementDateFormat): string {
  const value = raw.trim();
  const iso = value.match(ISO_DATE);
  if (iso) return buildIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), raw);
  const short = value.match(SHORT_DATE);
  if (short && format !== 'ymd') {
    const [a, b, y] = [Number(short[1]), Number(short[2]), Number(short[3])];
    return format === 'dmy' ? buildIsoDate(y, b, a, raw) : buildIsoDate(y, a, b, raw);
  }
  throw new Error(`Unrecognised date "${raw}". Use YYYY-MM-DD, or pass --date-format dmy|mdy for DD/MM/YYYY or MM/DD/YYYY.`);
}

function parseCell(raw: string | undefined): number | null {
  const v = (raw ?? '').trim();
  if (v === '') return null;
  return looselyParseAmount(v);
}

/**
 * Parse a CSV bank statement. Finds the header row (banks often put a few
 * lines of preamble above it), maps columns by name — a signed `amount`
 * column or a `debit`/`credit` pair — and skips rows with no date, which is
 * where banks put their totals.
 */
export function parseStatementCsv(text: string, options: StatementParseOptions = {}): StatementLine[] {
  const rows = parseCsvRows(text);
  const find = (headers: string[], key: keyof typeof HEADER_ALIASES) =>
    headers.findIndex(h => HEADER_ALIASES[key].includes(h));

  const headerIndex = rows.slice(0, 20).findIndex(r => find(r.map(normalizeHeader), 'date') !== -1);
  if (headerIndex === -1) {
    throw new Error(
      `No date column found in the statement header. Expected one of: ${HEADER_ALIASES.date.join(', ')}.`
    );
  }
  const headers = rows[headerIndex].map(normalizeHeader);
  const col = {
    date: find(headers, 'date'),
    amount: find(headers, 'amount'),
    debit: find(headers, 'debit'),
    credit: find(headers, 'credit'),
    payee: find(headers, 'payee'),
    description: find(headers, 'description'),
    id: find(headers, 'id'),
  };
  if (col.amount === -1 && col.debit === -1 && col.credit === -1) {
    throw new Error(
      `No amount column found. Expected "amount", or "debit"/"credit" columns. Found: ${rows[headerIndex].join(', ')}`
    );
  }

  const body = rows.slice(headerIndex + 1).filter(r => (r[col.date] ?? '').trim() !== '');
  const format = resolveDateFormat(body.map(r => r[col.date]), options.dateFormat);
  const sign = options.invert ? -1 : 1;

  return body.map((r, i) => {
    const rowNo = headerIndex + i + 2;
    let major: number | null;
    if (col.amount !== -1 && (r[col.amount] ?? '').trim() !== '') {
      major = parseCell(r[col.amount]);
    } else {
      const debit = col.debit !== -1 ? parseCell(r[col.debit]) : null;
      const credit = col.credit !== -1 ? parseCell(r[col.credit]) : null;
      major = debit == null && credit == null ? null : Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
    }
    if (major == null || !Number.isFinite(major)) {
      throw new Error(`Statement row ${rowNo}: no readable amount.`);
    }
    let date: string;
    try {
      date = parseStatementDate(r[col.date], format);
    } catch (e: any) {
      throw new Error(`Statement row ${rowNo}: ${e.message}`);
    }
    const line: StatementLine = { date, amount: sign * Math.round(major * 100) };
    const payee = col.payee !== -1 ? r[col.payee]?.trim() : '';
    const description = col.description !== -1 ? r[col.description]?.trim() : '';
    const id = col.id !== -1 ? r[col.id]?.trim() : '';
    if (payee) line.payee = payee;
    if (description) line.description = description;
    if (id) line.id = id;
    return line;
  });
}

/**
 * Parse a JSON statement: either an array of lines or
 * `{ lines, opening_balance?, closing_balance? }`. Amounts are MAJOR units,
 * as numbers or as strings a bank would print.
 */
export function parseStatementJson(text: string, options: StatementParseOptions = {}): ParsedStatement {
  const data = JSON.parse(text);
  const rawLines: any[] = Array.isArray(data) ? data : data?.lines;
  if (!Array.isArray(rawLines)) {
    throw new Error('A JSON statement must be an array of lines or an object with a "lines" array.');
  }
  const toMajor = (v: unknown): number | null =>
    typeof v === 'number' ? v : typeof v === 'string' ? looselyParseAmount(v.trim()) : null;
  const format = resolveDateFormat(rawLines.map(l => String(l?.date ?? '')), options.dateFormat);
  const sign = options.invert ? -1 : 1;

  const lines = rawLines.map((l, i) => {
    const major = toMajor(l?.amount);
    if (major == null || !Number.isFinite(major)) {
      throw new Error(`Statement line ${i + 1}: amount must be a number, got "${l?.amount}".`);
    }
    const line: StatementLine = {
      date: parseStatementDate(String(l?.date ?? ''), format),
      amount: sign * Math.round(major * 100),
    };
    if (l.payee) line.payee = String(l.payee);
    if (l.description) line.description = String(l.description);
    if (l.id != null && l.id !== '') line.id = String(l.id);
    return line;
  });

  const out: ParsedStatement = { lines };
  if (!Array.isArray(data)) {
    const opening = toMajor(data.opening_balance ?? data.openingBalance);
    const closing = toMajor(data.closing_balance ?? data.closingBalance);
    if (opening != null) out.openingBalance = Math.round(opening * 100);
    if (closing != null) out.closingBalance = Math.round(closing * 100);
  }
  return out;
}

/** Read a statement file. JSON when the extension or content says so, CSV otherwise. */
export function parseStatementFile(path: string, options: StatementParseOptions = {}): ParsedStatement {
  const text = fs.readFileSync(path, 'utf8');
  const looksJson = /\.json$/i.test(path) || /^\s*[[{]/.test(text.replace(/^﻿/, ''));
  return looksJson
    ? parseStatementJson(text.replace(/^﻿/, ''), options)
    : { lines: parseStatementCsv(text, options) };
}

/** Where a statement comes from: a file on disk, or lines inline in MAJOR units (MCP, `--lines`). */
export interface StatementSource {
  file?: string;
  lines?: MajorUnitStatementLine[];
  dateFormat?: string;
  invert?: boolean;
}

/** Resolve exactly one statement source into minor-unit lines. */
export function loadStatement(source: StatementSource): ParsedStatement {
  if (Boolean(source.file) === Boolean(source.lines)) {
    throw new Error('Pass exactly one statement source: a file (CSV or JSON) or inline lines.');
  }
  const dateFormat = source.dateFormat;
  if (dateFormat != null && !['ymd', 'dmy', 'mdy'].includes(dateFormat)) {
    throw new Error(`Unknown date format "${dateFormat}". Use ymd, dmy or mdy.`);
  }
  if (source.file) {
    return parseStatementFile(source.file, { dateFormat: dateFormat as StatementDateFormat | undefined, invert: source.invert });
  }
  if (!Array.isArray(source.lines)) throw new Error('Statement lines must be an array.');
  const lines = linesFromMajorUnits(source.lines);
  return { lines: source.invert ? lines.map(l => ({ ...l, amount: -l.amount })) : lines };
}

// ── Classification (pure) ───────────────────────────────────────────────────

export interface LedgerRowSummary {
  id: string;
  date: string;
  amount: number;
  payee_name: string | null;
  notes: string | null;
  cleared: boolean;
  reconciled: boolean;
  imported_id: string | null;
  transfer: boolean;
}

export interface StatementLineRef extends StatementLine {
  /** 0-based position in the input. */
  index: number;
}

export interface StatementMatch {
  line: StatementLineRef;
  transaction: LedgerRowSummary;
  /** `exact`: same date and amount. `fuzzy`: merchant + date window, amounts agree. */
  how: 'exact' | 'fuzzy';
  confidence: 'exact' | 'high' | 'medium';
  score: number | null;
  reasons: string[];
}

export interface StatementAmountMismatch {
  line: StatementLineRef;
  transaction: LedgerRowSummary;
  /** The statement line in ledger (base) minor units. */
  statementCents: number;
  ledgerCents: number;
  /** statement − ledger. */
  differenceCents: number;
  confidence: 'high' | 'medium';
  score: number;
  reasons: string[];
}

export interface StatementAmbiguous {
  line: StatementLineRef;
  /** The best candidate; at least one other scored within a whisker of it. */
  transaction: LedgerRowSummary;
  score: number;
  reasons: string[];
}

export interface StatementClassification {
  matched: StatementMatch[];
  missingInLedger: StatementLineRef[];
  extraInLedger: LedgerRowSummary[];
  amountMismatches: StatementAmountMismatch[];
  ambiguous: StatementAmbiguous[];
}

export function summarizeRow(t: DBTransaction): LedgerRowSummary {
  return {
    id: t.id,
    date: t.date,
    amount: t.amount,
    payee_name: t.payee_name,
    notes: t.notes,
    cleared: Boolean(t.cleared),
    reconciled: Boolean(t.reconciled),
    imported_id: t.imported_id ?? null,
    transfer: Boolean(t.transfer_id),
  };
}

function lineDescriptor(line: StatementLine): string | undefined {
  return line.payee || line.description || undefined;
}

/** Statement lines → the app's import row shape (major units, sign in `type`). */
export function toImportedRows(lines: StatementLine[], accountName: string): ImportedStatementTransaction[] {
  return lines.map(l => ({
    account: accountName,
    type: l.amount < 0 ? 'expense' : 'income',
    amount: Math.abs(l.amount) / 100,
    payee: lineDescriptor(l),
    notes: l.payee && l.description && l.description !== l.payee ? l.description : undefined,
    date: l.date,
  }));
}

function amountsAgree(match: StatementReconciliationMatch, rule: CurrencyRule | undefined): boolean {
  if (rule && match.existingAccountCurrencyAmount !== null) {
    return Math.abs(match.statementAccountCurrencyAmount - match.existingAccountCurrencyAmount) < 0.005;
  }
  const statementCents = Math.round(match.statementStoredAmount * 100);
  // Base amounts on an FX account were each rounded once on the way in.
  return Math.abs(statementCents - Math.abs(match.existingTransaction.amount)) <= (rule ? 1 : 0);
}

/**
 * Sort every statement line into exactly one bucket, one ledger row per line.
 *
 * Pass 1 is the app's exact rule (`checkForDuplicates`: same date, same
 * amount; for an FX account the foreign amount in the note). The app lets
 * two identical lines claim the same row — two coffees on one day against a
 * single ledger coffee — so here the first line wins and the second falls
 * through. Pass 2 is the app's fuzzy matcher with pass 1's rows already
 * claimed; a confident match whose amount differs is a mismatch, not a match.
 */
export function classifyStatement(
  ledger: LedgerSource,
  lines: StatementLine[],
  account: AccountInfo,
  periodRows: DBTransaction[],
  options: { currencyRule?: CurrencyRule; dateWindowDays?: number; payeeAliases?: Map<string, string[]> } = {},
): StatementClassification {
  const rule = options.currencyRule;
  const rules = rule ? [rule] : [];
  const imported = toImportedRows(lines, account.name);
  const ref = (index: number): StatementLineRef => ({ index, ...lines[index] });

  const out: StatementClassification = {
    matched: [],
    missingInLedger: [],
    extraInLedger: [],
    amountMismatches: [],
    ambiguous: [],
  };
  const claimed = new Set<string>();
  const handled = new Set<number>();

  const exact = checkForDuplicates(ledger, imported, [account], rules);
  for (const [index, { existingTransaction }] of [...exact.entries()].sort((a, b) => a[0] - b[0])) {
    if (claimed.has(existingTransaction.id)) continue;
    claimed.add(existingTransaction.id);
    handled.add(index);
    out.matched.push({
      line: ref(index),
      transaction: summarizeRow(existingTransaction),
      how: 'exact',
      confidence: 'exact',
      score: null,
      reasons: ['same date', 'same amount'],
    });
  }

  const fuzzy = findStatementReconciliations(ledger, imported, [account], rules, {
    excludeIndices: handled,
    dateWindowDays: options.dateWindowDays,
    payeeAliases: options.payeeAliases,
    claimedTransactionIds: claimed,
  });
  for (const [index, match] of [...fuzzy.entries()].sort((a, b) => a[0] - b[0])) {
    handled.add(index);
    const tx = match.existingTransaction;
    if (match.confidence === 'ambiguous') {
      out.ambiguous.push({ line: ref(index), transaction: summarizeRow(tx), score: match.score, reasons: match.reasons });
      continue;
    }
    claimed.add(tx.id);
    if (amountsAgree(match, rule)) {
      out.matched.push({
        line: ref(index),
        transaction: summarizeRow(tx),
        how: 'fuzzy',
        confidence: match.confidence,
        score: Math.round(match.score),
        reasons: match.reasons,
      });
    } else {
      const statementCents = Math.sign(lines[index].amount) * Math.round(match.statementStoredAmount * 100);
      out.amountMismatches.push({
        line: ref(index),
        transaction: summarizeRow(tx),
        statementCents,
        ledgerCents: tx.amount,
        differenceCents: statementCents - tx.amount,
        confidence: match.confidence,
        score: Math.round(match.score),
        reasons: match.reasons,
      });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (!handled.has(i)) out.missingInLedger.push(ref(i));
  }

  // A claimed split child accounts for its parent too.
  const claimedParents = new Set(
    periodRows.filter(t => claimed.has(t.id) && t.parent_id).map(t => t.parent_id as string)
  );
  out.extraInLedger = periodRows
    .filter(t => !t.tombstone && !t.is_child && !claimed.has(t.id) && !claimedParents.has(t.id))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(summarizeRow);

  return out;
}

// ── Ledger loading ──────────────────────────────────────────────────────────

interface AccountLedger {
  account: AccountInfo;
  currencyRule?: CurrencyRule;
  rows: DBTransaction[];
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function loadAccount(client: ActualClient, accountId: string): Promise<AccountInfo> {
  const accounts = await client.api.getAccounts();
  const account = (accounts as any[]).find(a => a.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);
  return { id: account.id, name: account.name, type: account.type };
}

/** FX rules carry the rate the app's matchers need (base per foreign unit). */
async function currencyRulesFor(client: ActualClient): Promise<Map<string, CurrencyRule>> {
  const fxMap = await getAccountFxMap(client);
  const out = new Map<string, CurrencyRule>();
  for (const [accountId, fx] of Object.entries(fxMap)) {
    out.set(accountId, { id: `fx-${accountId}`, accountId, currencyCode: fx.currency, rate: fx.rate });
  }
  return out;
}

async function loadLedger(
  client: ActualClient,
  account: AccountInfo,
  rules: Map<string, CurrencyRule>,
  start?: string,
  end?: string,
): Promise<AccountLedger> {
  const [payees, txns] = await Promise.all([
    client.api.getPayees(),
    client.api.getTransactions(account.id, start, end),
  ]);
  const rows = flattenLedger(txns as unknown as ApiTransactionLike[], {
    payeeNames: nameMap(payees as any[]),
    accountNames: new Map([[account.id, account.name]]),
  });
  return { account, currencyRule: rules.get(account.id), rows };
}

// ── statement ───────────────────────────────────────────────────────────────

export interface StatementInput {
  accountId: string;
  lines: StatementLine[];
  /** How far a posting date may drift from the ledger date. Default 2, the app's window. */
  windowDays?: number;
  /** Minor units. With dates from the lines, compared against the ledger's balance at each end. */
  openingBalance?: number;
  closingBalance?: number;
}

export interface StatementReport extends StatementClassification {
  accountId: string;
  accountName: string;
  /** Statement amounts are in this currency when the account has an FX rule. */
  currency: string | null;
  period: { start: string; end: string } | null;
  /** Zero-amount lines (authorisation holds and the like) are not matched or imported. */
  ignored: StatementLineRef[];
  balance: StatementBalanceComparison | null;
  summary: {
    lines: number;
    matched: number;
    missingInLedger: number;
    extraInLedger: number;
    amountMismatches: number;
    ambiguous: number;
    ignored: number;
  };
}

/**
 * Compare a bank statement against an account's ledger. Read-only.
 *
 * `extraInLedger` covers the statement's own date range: ledger rows in that
 * range that no statement line accounts for.
 */
export async function statement(client: ActualClient, input: StatementInput): Promise<StatementReport> {
  client.ensureConnected();
  validateId(input.accountId);
  const lines = input.lines.map((l, i) => {
    validateDate(l.date);
    if (!Number.isInteger(l.amount)) throw new Error(`Statement line ${i + 1}: amount must be integer minor units.`);
    return l;
  });
  if (input.windowDays != null && (!Number.isInteger(input.windowDays) || input.windowDays < 0)) {
    throw new Error('windowDays must be a non-negative integer.');
  }
  const windowDays = input.windowDays ?? 2;

  const account = await loadAccount(client, input.accountId);
  const rules = await currencyRulesFor(client);

  const active = lines.map((l, index) => ({ l, index })).filter(({ l }) => l.amount !== 0);
  const ignored = lines.map((l, index) => ({ index, ...l })).filter(l => l.amount === 0);
  const dates = active.map(({ l }) => l.date).sort();
  const period = dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;

  const wantsBalance = input.openingBalance != null || input.closingBalance != null;
  // The balance check needs the whole history; the match alone needs the window.
  const ledger = wantsBalance || !period
    ? await loadLedger(client, account, rules)
    : await loadLedger(client, account, rules, shiftDate(period.start, -windowDays - 1), shiftDate(period.end, windowDays + 1));
  const source = inMemoryLedger(ledger.rows);

  const periodRows = period
    ? ledger.rows.filter(t => t.date >= period.start && t.date <= period.end)
    : [];
  const classified = classifyStatement(
    source,
    active.map(({ l }) => l),
    account,
    periodRows,
    { currencyRule: ledger.currencyRule, dateWindowDays: windowDays },
  );
  // Restore indices into the caller's list (zero lines were dropped above).
  const remap = <T extends { line: StatementLineRef }>(x: T): T => ({ ...x, line: { ...x.line, index: active[x.line.index].index } });
  const result: StatementClassification = {
    matched: classified.matched.map(remap),
    amountMismatches: classified.amountMismatches.map(remap),
    ambiguous: classified.ambiguous.map(remap),
    missingInLedger: classified.missingInLedger.map(l => ({ ...l, index: active[l.index].index })),
    extraInLedger: classified.extraInLedger,
  };

  let balance: StatementBalanceComparison | null = null;
  if (wantsBalance && period) {
    // The app's comparison takes major units and applies its credit-card
    // flip by account type; a CLI statement is already signed from the
    // holder's side, so the type is withheld to keep the sign as given.
    balance = compareStatementBalances(
      {
        account: account.name,
        statementStartDate: period.start,
        statementEndDate: period.end,
        openingBalance: input.openingBalance != null ? input.openingBalance / 100 : null,
        closingBalance: input.closingBalance != null ? input.closingBalance / 100 : null,
      },
      { id: account.id, name: account.name },
      source.getAccountBalanceAsOf(account.id, period.start, false),
      source.getAccountBalanceAsOf(account.id, period.end, true),
      ledger.currencyRule,
    );
  }

  return {
    accountId: account.id,
    accountName: account.name,
    currency: ledger.currencyRule?.currencyCode ?? null,
    period,
    ...result,
    ignored,
    balance,
    summary: {
      lines: lines.length,
      matched: result.matched.length,
      missingInLedger: result.missingInLedger.length,
      extraInLedger: result.extraInLedger.length,
      amountMismatches: result.amountMismatches.length,
      ambiguous: result.ambiguous.length,
      ignored: ignored.length,
    },
  };
}

// ── apply ───────────────────────────────────────────────────────────────────

/**
 * The imported_id for a statement line. A bank id makes it exact. Without
 * one, the first occurrence hashes the same parts `arc transactions import`
 * uses — so a line imported either way dedupes against the other — and
 * repeats of an identical line (two coffees, same day, same price) get an
 * occurrence suffix so both import and a re-run still dedupes each.
 */
export function statementImportedId(accountId: string, line: StatementLine, occurrence: number, notes?: string): string {
  if (line.id) return makeImportedId([accountId, 'statement', line.id]);
  const parts: Array<string | number> = [accountId, line.date, line.amount, lineDescriptor(line) || '', notes || ''];
  if (occurrence > 0) parts.push(`#${occurrence}`);
  return makeImportedId(parts);
}

export function buildStatementImports(accountId: string, lines: StatementLineRef[], all: StatementLine[]): TransactionCreate[] {
  const seen = new Map<string, number>();
  const occurrenceOf = new Map<number, number>();
  all.forEach((l, i) => {
    const key = `${l.date}|${l.amount}|${lineDescriptor(l) ?? ''}|${l.description ?? ''}`;
    const n = seen.get(key) ?? 0;
    occurrenceOf.set(i, n);
    seen.set(key, n + 1);
  });

  return lines.map(l => {
    const notes = l.payee && l.description && l.description !== l.payee ? l.description : undefined;
    return validateTransaction({
      date: l.date,
      amount: l.amount,
      payee_name: lineDescriptor(l),
      imported_payee: lineDescriptor(l),
      notes,
      cleared: true,
      imported_id: statementImportedId(accountId, l, occurrenceOf.get(l.index) ?? 0, notes),
    });
  });
}

export interface ApplyStatementResult {
  accountId: string;
  accountName: string;
  imported: number;
  /** Rows Actual's own import matching folded into an existing transaction instead of adding. */
  updatedByImport: number;
  importErrors: string[];
  cleared: number;
  alreadyCleared: number;
  /** Left alone: an amount disagreement or a tie needs a person. */
  skipped: { amountMismatches: number; ambiguous: number; ignored: number };
  report: StatementReport;
}

/**
 * Import the lines the ledger is missing and mark matched rows cleared, in
 * one SafeWriter transaction. The comparison runs inside the write, after
 * its sync, so it acts on the ledger as it is now rather than as it was when
 * someone last looked.
 *
 * Amount mismatches and ambiguous matches are reported, never touched.
 */
export async function applyStatement(
  client: ActualClient,
  writer: SafeWriter,
  input: StatementInput,
): Promise<ApplyStatementResult> {
  validateId(input.accountId);

  const result = await writer.write(
    `Apply statement: ${input.lines.length} lines to ${input.accountId}`,
    async () => {
      const report = await statement(client, input);

      const toImport = buildStatementImports(report.accountId, report.missingInLedger, input.lines);
      let imported = 0;
      let updatedByImport = 0;
      let importErrors: string[] = [];
      if (toImport.length > 0) {
        type ImportRows = Parameters<typeof client.api.importTransactions>[1];
        const res: any = await client.api.importTransactions(report.accountId, toImport as ImportRows);
        const count = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0);
        imported = count(res?.added);
        updatedByImport = count(res?.updated);
        importErrors = (res?.errors ?? []).map((e: any) => e?.message ?? String(e));
      }

      let cleared = 0;
      let alreadyCleared = 0;
      for (const m of report.matched) {
        if (m.transaction.cleared || m.transaction.reconciled) { alreadyCleared++; continue; }
        await client.api.updateTransaction(m.transaction.id, { cleared: true });
        cleared++;
      }

      return {
        accountId: report.accountId,
        accountName: report.accountName,
        imported,
        updatedByImport,
        importErrors,
        cleared,
        alreadyCleared,
        skipped: {
          amountMismatches: report.amountMismatches.length,
          ambiguous: report.ambiguous.length,
          ignored: report.ignored.length,
        },
        report,
      };
    }
  );

  if (!result.success) throw new Error(result.error);
  return result.data;
}

// ── duplicates ──────────────────────────────────────────────────────────────

export interface DuplicatesInput {
  accountId?: string;
  /** YYYY-MM-DD. Default: 90 days ago. */
  since?: string;
  windowDays?: number;
  minScore?: number;
}

export interface DuplicateGroupReport {
  accountId: string;
  accountName: string;
  score: number;
  reasons: string[];
  transactions: LedgerRowSummary[];
}

/** Rows already in the ledger that look like the same transaction twice. Read-only. */
export async function duplicates(client: ActualClient, input: DuplicatesInput = {}): Promise<DuplicateGroupReport[]> {
  client.ensureConnected();
  const since = input.since ? validateDate(input.since) : shiftDate(todayIso(), -90);
  if (input.accountId) validateId(input.accountId);

  const accounts = (await client.api.getAccounts() as any[])
    .filter(a => (input.accountId ? a.id === input.accountId : !a.closed));
  if (input.accountId && accounts.length === 0) throw new Error(`Account not found: ${input.accountId}`);
  const rules = await currencyRulesFor(client);

  const groups: DuplicateGroupReport[] = [];
  for (const a of accounts) {
    const ledger = await loadLedger(client, { id: a.id, name: a.name }, rules, since);
    for (const g of findLedgerDuplicates(ledger.rows, {
      dateWindowDays: input.windowDays,
      minScore: input.minScore,
      currencyRules: ledger.currencyRule ? [ledger.currencyRule] : [],
    })) {
      groups.push({
        accountId: a.id,
        accountName: a.name,
        score: g.score,
        reasons: g.reasons,
        transactions: g.transactions.map(summarizeRow),
      });
    }
  }
  return groups.sort((x, y) => y.score - x.score);
}

// ── account reconcile ───────────────────────────────────────────────────────

export interface ReconcileAccountInput {
  accountId: string;
  /** What the bank says, in minor units. */
  statementBalanceCents: number;
  /** Statement date: only cleared rows on or before it count and lock. Default: all. */
  date?: string;
}

export interface ReconcileAccountResult {
  accountId: string;
  accountName: string;
  clearedBalance: number;
  statementBalance: number;
  locked: number;
  /** Millisecond epoch, as the string Actual stores. */
  lastReconciled: string;
}

/** Thrown when the cleared balance and the bank disagree. Nothing was written. */
export class ReconcileMismatchError extends Error {
  constructor(
    readonly accountId: string,
    readonly clearedBalance: number,
    readonly statementBalance: number,
    readonly difference: number,
    readonly adjustment: ReconcileAdjustment | null,
  ) {
    const magnitude = (Math.abs(difference) / 100).toFixed(2);
    const who = difference > 0
      ? `The bank has ${magnitude} more than arc has cleared`
      : `arc has ${magnitude} more cleared than the bank`;
    super(
      `Not reconciled: cleared balance ${(clearedBalance / 100).toFixed(2)} vs statement ` +
      `${(statementBalance / 100).toFixed(2)} (difference ${(difference / 100).toFixed(2)}). ${who}. ` +
      'Clear or add the missing transactions — `arc reconcile statement` shows which — or add a ' +
      `"${adjustment?.payee}" transaction of ${magnitude}, then run this again.`
    );
    this.name = 'ReconcileMismatchError';
  }
}

/** `api.updateAccount`'s typings stop at name/offbudget/closed; the handler passes `last_reconciled` straight to the row. */
type AccountUpdateWithReconcile = Parameters<ActualClient['api']['updateAccount']>[1] & { last_reconciled?: string };

/**
 * Lock an account against a bank balance, as Actual desktop's "Done
 * reconciling" does: refuse while the cleared balance differs, otherwise set
 * `reconciled` on every cleared row and stamp `last_reconciled`.
 *
 * Checked twice: once before taking the write lock so a mismatch refuses
 * without a backup or a sync, and again inside the write in case the sync
 * brought in changes.
 */
export async function reconcileAccount(
  client: ActualClient,
  writer: SafeWriter,
  input: ReconcileAccountInput,
): Promise<ReconcileAccountResult> {
  client.ensureConnected();
  validateId(input.accountId);
  if (!Number.isInteger(input.statementBalanceCents)) {
    throw new Error('statementBalanceCents must be integer minor units.');
  }
  if (input.date) validateDate(input.date);
  const account = await loadAccount(client, input.accountId);

  const check = async () => {
    const txns = await client.api.getTransactions(account.id, undefined, input.date);
    const { clearedBalance, toLock } = clearedBalanceOf(txns as any[], input.date);
    const cmp = compareCentsToClearedBalance(clearedBalance, input.statementBalanceCents);
    if (!cmp.isBalanced) {
      throw new ReconcileMismatchError(
        account.id,
        clearedBalance,
        input.statementBalanceCents,
        cmp.difference!,
        buildReconcileAdjustment(cmp.difference, input.date ?? todayIso()),
      );
    }
    return { clearedBalance, toLock };
  };

  await check();

  let mismatch: ReconcileMismatchError | null = null;
  const result = await writer.write(`Reconcile account: ${account.name}`, async () => {
    let state: { clearedBalance: number; toLock: string[] };
    try {
      state = await check();
    } catch (e) {
      if (e instanceof ReconcileMismatchError) mismatch = e;
      throw e;
    }
    for (const id of state.toLock) {
      await client.api.updateTransaction(id, { reconciled: true });
    }
    const lastReconciled = String(Date.now());
    const fields: AccountUpdateWithReconcile = { last_reconciled: lastReconciled };
    await client.api.updateAccount(account.id, fields);
    return {
      accountId: account.id,
      accountName: account.name,
      clearedBalance: state.clearedBalance,
      statementBalance: input.statementBalanceCents,
      locked: state.toLock.length,
      lastReconciled,
    };
  });

  if (mismatch) throw mismatch;
  if (!result.success) throw new Error(result.error);
  return result.data;
}

/**
 * Replace a statement `file` in gated args with the lines it holds, in major
 * units, so an approval covers the statement's contents and not just its path.
 * Without this, the CSV could be edited between approve and run and the
 * approval would still hold. Mutates and returns `args` (snake_case keys, as the
 * gate sees them). A no-op when there is no `file`.
 */
export function inlineStatementFile<T extends Record<string, unknown>>(args: T): T {
  const file = args.file;
  if (typeof file !== 'string' || !file) return args;
  const parsed = loadStatement({
    file,
    dateFormat: typeof args.date_format === 'string' ? args.date_format : undefined,
    invert: args.invert === true || args.invert === 'true',
  });
  const a = args as Record<string, unknown>;
  a.lines = parsed.lines.map(l => ({ ...l, amount: l.amount / 100 }));
  delete a.file;
  delete a.date_format;
  delete a.invert;
  if (a.opening_balance == null && parsed.openingBalance != null) a.opening_balance = parsed.openingBalance / 100;
  if (a.closing_balance == null && parsed.closingBalance != null) a.closing_balance = parsed.closingBalance / 100;
  return args;
}
