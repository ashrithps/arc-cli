// Ported near-verbatim from the arc app (budgetarc utils/statementCheckpoints.ts, 1.0.50).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * `arc-statements:<accountId>`: a statement's checkpoint for any account,
 * kept in a notes row (docs/specs/debt-cycle.md §9). Pure: parse, merge,
 * encode. services/statements/StatementCheckpointService.ts reads and writes.
 *
 * Amounts are ×100 as Actual stores them (§0), signed as Actual stores the
 * balance (a card that owes is negative), in the account's currency.
 */

import { parseAliases, type PayeeAliases } from './statement-aliases.js';

export const STATEMENTS_NOTE_PREFIX = 'arc-statements:';
export const statementsNoteId = (accountId: string) => `${STATEMENTS_NOTE_PREFIX}${accountId}`;

export type CheckpointSource = 'typed' | 'import' | 'capture';
const RANK: Record<CheckpointSource, number> = { typed: 3, import: 2, capture: 1 };

export interface StatementCheckpoint {
  /** Period start, YYYY-MM-DD. */
  start?: string;
  /** Period end, YYYY-MM-DD. The key. */
  end: string;
  open?: number;
  close?: number;
  cur?: string;
  intEarned?: number;
  intCharged?: number;
  fees?: number;
  src: CheckpointSource;
  /** sha256 of the PDF or the email body. */
  doc?: string;
  /** Rows this statement added (batch undo). */
  added?: string[];
  /** Rows this statement marked cleared that weren't (undo puts them back). */
  cleared?: string[];
  /** Rows this statement locked as reconciled (undo unlocks them). */
  locked?: string[];
  /** Foreign purchases it updated to what the bank charged: undo puts back `from` and the old note. */
  updated?: Array<{ id: string; from: number; to: number; note?: string }>;
  /** Added rows written as a transfer linked to a row the user already had: undo unlinks that row. */
  linked?: Array<{ id: string; leg: string; payee: string | null; cat: string | null }>;
  /** Each written row's fingerprint after filing: undo leaves a row changed since. */
  sigs?: Record<string, string>;
  /** How each added row got its category: "rule", "history" (like last time) or "none". */
  how?: Record<string, 'rule' | 'history' | 'none'>;
  matched?: { state: 'matches' | 'off'; diff: number; at: number };
  /** When the statement was filed (epoch ms). */
  at?: number;
}

export interface StatementAnchor {
  at: string;
  amount: number;
  cur?: string;
  kind: 'available' | 'ledger' | 'unknown';
  rel: 'after_txn' | 'standalone';
  txn?: string;
  src: CheckpointSource;
}

/** What arc learned about the account's cycle from its statements (utils/statementCycleLearning). */
export interface LearnedRecord {
  stmtDay: number;
  /** "d5" (the 5th) or "o20" (20 days after the statement). */
  due?: string;
  weekend?: 'next_business_day' | 'previous_business_day' | 'none';
  /** The tag fields arc filled in, so the card can say "learned from your statements". */
  wrote?: string[];
  at: number;
}

/** Dates beyond the cycle, learned from statements (utils/statementProjections). */
export interface LearnedDates {
  /** The annual fee's month (1–12) and day. */
  fee?: { m: number; d: number };
  promoEnd?: string;
  /** The loan's projected last EMI and how many are left after the latest statement. */
  loanEnd?: string;
  loanLeft?: number;
}

export interface StatementsRecord {
  v: 1;
  stmts: StatementCheckpoint[];
  anchors: StatementAnchor[];
  notDup: Array<[string, string]>;
  learned?: LearnedRecord;
  /** The card's usual markup on foreign purchases, learned from statements (0.035 = 3.5%). */
  fx?: { markup: number; n: number };
  dates?: LearnedDates;
  /** The user's payee names for the bank's texts, learned from matched rows (utils/statementAliases). */
  aliases?: PayeeAliases;
  /** Fee rows the user said aren't worth asking back (utils/statementFees). */
  feesOk?: string[];
  /** This account's statements wait for a look instead of filing on their own (ux R29). */
  manual?: true;
  /** Where the user said a transfer line of each wording goes: narrationKey → account id (ux R26). */
  routes?: Record<string, string>;
  /** The card's tag fields arc filled from statements (rate, min, autopay, limit…), shown as "learned". */
  wrote?: string[];
  /** A loan's next instalments from its statement's schedule: [date, principal, interest] ×100 (ux R30). */
  loanSched?: Array<[string, number, number]>;
}

export const MAX_STATEMENTS = 13;
export const MAX_ANCHORS = 60;
export const MAX_ROUTES = 40;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
const ids = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

export function emptyStatementsRecord(): StatementsRecord {
  return { v: 1, stmts: [], anchors: [], notDup: [] };
}

/** A malformed or newer row reads as what can be understood of it; never throws. */
export function parseStatementsRecord(raw: string | null | undefined): StatementsRecord {
  if (!raw) return emptyStatementsRecord();
  let json: any;
  try { json = JSON.parse(raw); } catch { return emptyStatementsRecord(); }
  if (!json || typeof json !== 'object') return emptyStatementsRecord();
  const stmts: StatementCheckpoint[] = [];
  for (const s of Array.isArray(json.stmts) ? json.stmts : []) {
    if (!s || typeof s.end !== 'string' || !DAY.test(s.end)) continue;
    const src: CheckpointSource = s.src === 'typed' || s.src === 'capture' ? s.src : 'import';
    const out: StatementCheckpoint = { end: s.end, src };
    if (typeof s.start === 'string' && DAY.test(s.start)) out.start = s.start;
    for (const k of ['open', 'close', 'intEarned', 'intCharged', 'fees', 'at'] as const) {
      const v = int(s[k]);
      if (v !== undefined) out[k] = v;
    }
    if (typeof s.cur === 'string') out.cur = s.cur;
    if (typeof s.doc === 'string') out.doc = s.doc;
    for (const k of ['added', 'cleared', 'locked'] as const) {
      const v = ids(s[k]);
      if (v && v.length) out[k] = v;
    }
    if (Array.isArray(s.updated)) {
      const updated = s.updated
        .filter((u: any) => u && typeof u.id === 'string' && Number.isFinite(u.from) && Number.isFinite(u.to))
        .map((u: any) => ({ id: u.id, from: Math.round(u.from), to: Math.round(u.to), ...(typeof u.note === 'string' ? { note: u.note } : {}) }));
      if (updated.length) out.updated = updated;
    }
    if (s.sigs && typeof s.sigs === 'object' && !Array.isArray(s.sigs)) {
      const sigs = Object.fromEntries(Object.entries(s.sigs).filter((e): e is [string, string] => typeof e[1] === 'string'));
      if (Object.keys(sigs).length) out.sigs = sigs;
    }
    if (s.how && typeof s.how === 'object' && !Array.isArray(s.how)) {
      const how = Object.fromEntries(Object.entries(s.how).filter((e): e is [string, 'rule' | 'history' | 'none'] => e[1] === 'rule' || e[1] === 'history' || e[1] === 'none'));
      if (Object.keys(how).length) out.how = how;
    }
    if (Array.isArray(s.linked)) {
      const str = (v: unknown) => (typeof v === 'string' ? v : null);
      const linked = s.linked
        .filter((l: any) => l && typeof l.id === 'string' && typeof l.leg === 'string')
        .map((l: any) => ({ id: l.id, leg: l.leg, payee: str(l.payee), cat: str(l.cat) }));
      if (linked.length) out.linked = linked;
    }
    if (s.matched && (s.matched.state === 'matches' || s.matched.state === 'off')) {
      out.matched = { state: s.matched.state, diff: int(s.matched.diff) ?? 0, at: int(s.matched.at) ?? 0 };
    }
    stmts.push(out);
  }
  const anchors = (Array.isArray(json.anchors) ? json.anchors : []).filter((a: any) => a && typeof a.at === 'string' && typeof a.amount === 'number');
  const notDup = (Array.isArray(json.notDup) ? json.notDup : []).filter(
    (p: any) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string',
  );
  const l = json.learned;
  const learned: LearnedRecord | undefined = l && typeof l.stmtDay === 'number' && l.stmtDay >= 1 && l.stmtDay <= 31
    ? {
      stmtDay: l.stmtDay,
      ...(typeof l.due === 'string' && /^[do]\d{1,2}$/.test(l.due) ? { due: l.due } : {}),
      ...(['next_business_day', 'previous_business_day', 'none'].includes(l.weekend) ? { weekend: l.weekend } : {}),
      ...(Array.isArray(l.wrote) ? { wrote: l.wrote.filter((x: unknown) => typeof x === 'string') } : {}),
      at: int(l.at) ?? 0,
    }
    : undefined;
  const fx = json.fx && Number.isFinite(json.fx.markup) && Number.isFinite(json.fx.n) ? { markup: json.fx.markup, n: json.fx.n } : undefined;
  const d = json.dates;
  const dates: LearnedDates = {};
  if (d && typeof d === 'object') {
    if (d.fee && int(d.fee.m)! >= 1 && int(d.fee.m)! <= 12 && int(d.fee.d)! >= 1 && int(d.fee.d)! <= 31) dates.fee = { m: int(d.fee.m)!, d: int(d.fee.d)! };
    if (typeof d.promoEnd === 'string' && DAY.test(d.promoEnd)) dates.promoEnd = d.promoEnd;
    if (typeof d.loanEnd === 'string' && DAY.test(d.loanEnd)) dates.loanEnd = d.loanEnd;
    if (int(d.loanLeft) !== undefined) dates.loanLeft = int(d.loanLeft);
  }
  const hasDates = Object.keys(dates).length > 0;
  const aliases = parseAliases(json.aliases);
  const feesOk = ids(json.feesOk)?.slice(-40);
  const loanSched: Array<[string, number, number]> = (Array.isArray(json.loanSched) ? json.loanSched : [])
    .filter((e: unknown): e is [string, number, number] => Array.isArray(e) && typeof e[0] === 'string' && DAY.test(e[0]) && Number.isInteger(e[1]) && Number.isInteger(e[2]))
    .slice(0, 24);
  const routeEntries = json.routes && typeof json.routes === 'object' && !Array.isArray(json.routes)
    ? Object.entries(json.routes as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1])
    : [];
  const routes = routeEntries.length ? Object.fromEntries(routeEntries.slice(-MAX_ROUTES)) : undefined;
  return {
    v: 1, stmts: sortStmts(stmts), anchors, notDup,
    ...(learned ? { learned } : {}), ...(fx ? { fx } : {}), ...(hasDates ? { dates } : {}), ...(aliases ? { aliases } : {}), ...(feesOk?.length ? { feesOk } : {}),
    ...(json.manual === true ? { manual: true as const } : {}),
    ...(routes ? { routes } : {}),
    ...(ids(json.wrote)?.length ? { wrote: ids(json.wrote) } : {}),
    ...(loanSched.length ? { loanSched } : {}),
  };
}

const sortStmts = (s: StatementCheckpoint[]) => [...s].sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));

export function encodeStatementsRecord(record: StatementsRecord): string | null {
  if (!record.stmts.length && !record.anchors.length && !record.notDup.length && !record.learned && !record.fx && !record.dates && !record.aliases && !record.feesOk?.length && !record.manual && !record.routes && !record.wrote?.length && !record.loanSched?.length) return null;
  return JSON.stringify({
    v: 1,
    stmts: sortStmts(record.stmts).slice(-MAX_STATEMENTS),
    ...(record.anchors.length ? { anchors: record.anchors.slice(-MAX_ANCHORS) } : {}),
    ...(record.notDup.length ? { notDup: record.notDup } : {}),
    ...(record.learned ? { learned: record.learned } : {}),
    ...(record.fx ? { fx: record.fx } : {}),
    ...(record.dates ? { dates: record.dates } : {}),
    ...(record.aliases ? { aliases: record.aliases } : {}),
    ...(record.feesOk?.length ? { feesOk: record.feesOk.slice(-40) } : {}),
    ...(record.manual ? { manual: true } : {}),
    ...(record.wrote?.length ? { wrote: record.wrote } : {}),
    ...(record.loanSched?.length ? { loanSched: record.loanSched.slice(0, 24) } : {}),
    ...(record.routes && Object.keys(record.routes).length ? { routes: Object.fromEntries(Object.entries(record.routes).slice(-MAX_ROUTES)) } : {}),
  });
}

const FIGURES = ['start', 'open', 'close', 'cur', 'intEarned', 'intCharged', 'fees'] as const;

/**
 * Merge a statement in. The same statement seen again (the same `doc`, or the
 * same `end` and `close`) is one entry; a field from a lower-ranked source
 * never replaces one from a higher (typed > import > capture). The row lists
 * (added, cleared, locked) and `matched` always take the newer filing.
 */
export function mergeStatement(record: StatementsRecord, incoming: StatementCheckpoint): StatementsRecord {
  const stmts = [...record.stmts];
  // One statement per period: the same document again, or a corrected one for
  // the same period end (its figures replace the earlier one's, by rank).
  const i = stmts.findIndex((s) => (incoming.doc && s.doc === incoming.doc) || s.end === incoming.end);
  if (i < 0) {
    stmts.push(incoming);
    return { ...record, stmts: sortStmts(stmts).slice(-MAX_STATEMENTS) };
  }
  const held = stmts[i];
  const wins = RANK[incoming.src] >= RANK[held.src];
  const merged: StatementCheckpoint = { ...held };
  for (const k of FIGURES) {
    const v = incoming[k];
    if (v === undefined) continue;
    if (held[k] === undefined || wins) (merged as any)[k] = v;
  }
  merged.end = incoming.end;
  if (wins) merged.src = incoming.src;
  if (incoming.doc) merged.doc = incoming.doc;
  for (const k of ['added', 'cleared', 'locked', 'updated', 'linked', 'sigs', 'how'] as const) {
    if (incoming[k]) (merged as any)[k] = incoming[k];
  }
  if (incoming.matched) merged.matched = incoming.matched;
  if (incoming.at) merged.at = incoming.at;
  stmts[i] = merged;
  return { ...record, stmts: sortStmts(stmts).slice(-MAX_STATEMENTS) };
}

/**
 * What a corrected statement for the same period changes, for the review to
 * show before it replaces the earlier figures. Empty when it's the same one.
 */
export function correctionOf(
  record: StatementsRecord,
  incoming: StatementCheckpoint,
): Array<{ field: (typeof FIGURES)[number]; was: unknown; now: unknown }> {
  const held = record.stmts.find((s) => s.end === incoming.end);
  if (!held || (incoming.doc && held.doc === incoming.doc)) return [];
  const out: Array<{ field: (typeof FIGURES)[number]; was: unknown; now: unknown }> = [];
  for (const field of FIGURES) {
    if (incoming[field] !== undefined && held[field] !== undefined && incoming[field] !== held[field]) {
      out.push({ field, was: held[field], now: incoming[field] });
    }
  }
  return out;
}

/** Take a filed statement back off the record (undo). */
export function removeStatement(record: StatementsRecord, end: string, doc?: string): StatementsRecord {
  return { ...record, stmts: record.stmts.filter((s) => !(s.end === end && (!doc || !s.doc || s.doc === doc))) };
}

/** "These two are different": the matcher never pairs them again. */
export function addNotDup(record: StatementsRecord, arcId: string, bankKey: string): StatementsRecord {
  if (record.notDup.some(([a, b]) => a === arcId && b === bankKey)) return record;
  // The last 500 pairs are plenty for a year of statements.
  return { ...record, notDup: [...record.notDup, [arcId, bankKey] as [string, string]].slice(-500) };
}

/** The newest statement, for "Matches the bank ✓ · Oct". */
/** The card fields arc filled from statements, for the "learned" marks (older records kept them on `learned`). */
export function learnedFields(record: StatementsRecord): string[] {
  return [...new Set([...(record.learned?.wrote ?? []), ...(record.wrote ?? [])])];
}

export function latestStatement(record: StatementsRecord): StatementCheckpoint | null {
  return record.stmts.length ? record.stmts[record.stmts.length - 1] : null;
}

/**
 * A stable key for a bank row, for notDup and for "already filed": its date,
 * amount in cents and the bank's text squeezed.
 */
export function bankRowKey(row: { date: string; amount: number; direction: 'debit' | 'credit'; description: string }): string {
  const text = row.description.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  return `${row.date}|${row.direction === 'debit' ? '-' : '+'}${Math.round(row.amount * 100)}|${text}`;
}
