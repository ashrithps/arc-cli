// Ported near-verbatim from the arc app (budgetarc utils/iouLedger.ts, 1.0.49): the
// IOUs ledger Splits keeps in the budget. Read side only; the writes live in the
// app's IouService and are not ported. A compatibility surface: keep it in step.
/**
 * Splits with people, kept as real money in one on-budget "IOUs" account.
 *
 * A share someone owes is a row in that account: positive, in the bill's
 * category, payee = the person. A share you owe is the same, negative. So the
 * category carries only your share in arc, in Actual web and in older arc
 * versions alike, and what is owed is in net worth (an asset, or a liability).
 * Settling up is a transfer between IOUs and the account the money moved
 * through; letting a share go is a categorised write-off.
 *
 * This file is the codec and the arithmetic, nothing that touches storage
 * (services/IouService). The earlier note-only `#gsplit|…` splits stay as they
 * are (utils/splitTokenParser) and are read alongside.
 *
 * Markers, all ignored by other arc versions and by Actual:
 * - IOUs account note:       `#iou:v1` (+ one `#iougroup:v1|…` line per saved group,
 *                            + one `#ioucarry:v1|…` line per balance carried into Splits)
 * - every IOUs row note:     `<what it was> #iou|v:1|k:<kind>|p:<person>[|gid:][|src:][|sh:]`
 * - the bill it came from:   `#shared|v:1|gid:<gid>|mine:<minor>`
 */
import { decodePerson, encodePerson, personKey } from './split-token.js';

export const IOU_ACCOUNT_TAG = '#iou:v1';
export const IOU_ACCOUNT_DEFAULT_NAME = 'IOUs';

/**
 * - `share`: they owe you part of a bill you paid (row positive)
 * - `owe`: you owe them part of a bill they paid (row negative)
 * - `settle`: money between you (a transfer leg)
 * - `forgive`: a balance let go (a write-off to a category)
 */
export type IouKind = 'share' | 'owe' | 'settle' | 'forgive';

export interface IouMarker {
  kind: IouKind;
  person: string;
  /** The split this row belongs to (share / owe). */
  gid?: string;
  /** The bill's own transaction, when it is in arc. */
  src?: string;
  /** Fraction of the bill this person's share is, 0..1 (share / owe). */
  share?: number;
}

const ROW_RE = /#iou\|[^\s#]+/;
const SHARED_RE = /#shared\|[^\s#]+/;
const GROUP_LINE_RE = /^#iougroup:v1\|.*$/gm;
const CARRY_LINE_RE = /^#ioucarry:v1\|.*$/gm;

function fields(token: string, prefix: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of token.slice(prefix.length).split('|')) {
    const at = pair.indexOf(':');
    if (at > 0) map[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return map;
}

export function serializeIouMarker(m: IouMarker): string {
  const parts = ['#iou', 'v:1', `k:${m.kind}`, `p:${encodePerson(m.person)}`];
  if (m.gid) parts.push(`gid:${m.gid}`);
  if (m.src) parts.push(`src:${m.src}`);
  if (m.share !== undefined && Number.isFinite(m.share)) parts.push(`sh:${Number(m.share.toFixed(6))}`);
  return parts.join('|');
}

export function parseIouMarker(notes: string | null | undefined): IouMarker | null {
  const match = notes?.match(ROW_RE);
  if (!match) return null;
  const f = fields(match[0], '#iou|');
  const kind = f.k as IouKind;
  if (!['share', 'owe', 'settle', 'forgive'].includes(kind) || !f.p) return null;
  const marker: IouMarker = { kind, person: decodePerson(f.p) };
  if (f.gid) marker.gid = f.gid;
  if (f.src) marker.src = f.src;
  const share = Number(f.sh);
  if (f.sh !== undefined && Number.isFinite(share) && share >= 0 && share <= 1) marker.share = share;
  return marker;
}

/** A row's note: what it was, then its marker. */
export function iouRowNote(label: string, marker: IouMarker): string {
  const text = label.trim();
  return text ? `${text} ${serializeIouMarker(marker)}` : serializeIouMarker(marker);
}

export interface SharedMarker {
  gid: string;
  /** Your own share of the bill, minor units. */
  mine: number;
}

export function serializeSharedMarker(m: SharedMarker): string {
  return `#shared|v:1|gid:${m.gid}|mine:${Math.round(m.mine)}`;
}

export function parseSharedMarker(notes: string | null | undefined): SharedMarker | null {
  const match = notes?.match(SHARED_RE);
  if (!match) return null;
  const f = fields(match[0], '#shared|');
  const mine = Number(f.mine);
  if (!f.gid || !Number.isFinite(mine) || mine < 0) return null;
  return { gid: f.gid, mine: Math.round(mine) };
}

/** The bill's note with its `#shared` marker set (replacing any there). */
export function withSharedMarker(notes: string | null | undefined, m: SharedMarker | null): string {
  const base = (notes ?? '').replace(SHARED_RE, '').replace(/\s{2,}/g, ' ').trim();
  if (!m) return base;
  return base ? `${base} ${serializeSharedMarker(m)}` : serializeSharedMarker(m);
}

/** The note without any IOU markers, for showing. */
export function stripIouMarkers(notes: string | null | undefined): string {
  return (notes ?? '').replace(ROW_RE, '').replace(SHARED_RE, '').replace(/\s{2,}/g, ' ').trim();
}

// ---------------------------------------------------------------- groups

export interface IouGroup {
  id: string;
  name: string;
  people: string[];
}

export function parseIouGroups(accountNote: string | null | undefined): IouGroup[] {
  const groups: IouGroup[] = [];
  for (const line of (accountNote ?? '').match(GROUP_LINE_RE) ?? []) {
    const f = fields(line, '#iougroup:v1|');
    if (!f.id || !f.name) continue;
    const people = (f.people ?? '').split(',').map(p => decodePerson(p.replace(/%2C/g, ','))).filter(Boolean);
    groups.push({ id: f.id, name: decodePerson(f.name), people });
  }
  return groups;
}

/** The account note with its group lines replaced by `groups` (other lines kept). */
export function withIouGroups(accountNote: string | null | undefined, groups: IouGroup[]): string {
  const kept = (accountNote ?? '').replace(GROUP_LINE_RE, '').split('\n').map(l => l.trimEnd()).filter(Boolean);
  if (!kept.includes(IOU_ACCOUNT_TAG)) kept.unshift(IOU_ACCOUNT_TAG);
  const lines = groups.map(g => `#iougroup:v1|id:${g.id}|name:${encodePerson(g.name)}|people:${g.people.map(p => encodePerson(p).replace(/,/g, '%2C')).join(',')}`);
  return [...kept, ...lines].join('\n');
}

// ---------------------------------------------------------------- carries

/**
 * A person's balance carried into a Splits thread (services/splits): the
 * thread now holds it, as one "Brought forward" expense the inviter's budget
 * never books (its rows here already do). `amount` is the balance carried,
 * signed as balances are: positive, they owed you.
 */
export interface IouCarry {
  person: string;
  threadId: string;
  eid: string;
  amount: number;
}

export function parseIouCarries(accountNote: string | null | undefined): IouCarry[] {
  const out: IouCarry[] = [];
  for (const line of (accountNote ?? '').match(CARRY_LINE_RE) ?? []) {
    const f = fields(line, '#ioucarry:v1|');
    const amount = Number(f.a);
    if (!f.p || !f.t || !f.e || !Number.isInteger(amount) || amount === 0) continue;
    out.push({ person: decodePerson(f.p), threadId: f.t, eid: f.e, amount });
  }
  return out;
}

/** The account note with its carry lines replaced by `carries` (other lines kept). */
export function withIouCarries(accountNote: string | null | undefined, carries: IouCarry[]): string {
  const kept = (accountNote ?? '').replace(CARRY_LINE_RE, '').split('\n').map(l => l.trimEnd()).filter(Boolean);
  if (!kept.includes(IOU_ACCOUNT_TAG)) kept.unshift(IOU_ACCOUNT_TAG);
  const lines = carries.map(c => `#ioucarry:v1|p:${encodePerson(c.person)}|t:${c.threadId}|e:${c.eid}|a:${Math.round(c.amount)}`);
  return [...kept, ...lines].join('\n');
}

/** Balances less what was carried into Splits: carried, a person is square here. */
export function lessCarried(balances: PersonBalance[], carries: IouCarry[]): PersonBalance[] {
  if (carries.length === 0) return balances;
  const carried = new Map<string, number>();
  for (const c of carries) carried.set(personKey(c.person), (carried.get(personKey(c.person)) ?? 0) + c.amount);
  return balances.map(b => {
    const c = carried.get(personKey(b.person));
    return c ? { ...b, balance: b.balance - c } : b;
  });
}

// ---------------------------------------------------------------- arithmetic

/** A row of the IOUs account, as read. Amounts in minor units, signed as stored. */
export interface IouRow {
  id: string;
  date: string;
  amount: number;
  /** The payee shown (the person on a share or owe row; an account on a transfer). */
  payee: string | null;
  notes: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
}

export interface IouEntry extends IouRow {
  person: string;
  kind: IouKind;
  marker: IouMarker | null;
}

/**
 * Who each row is with. A row typed into the account in Actual web with a
 * payee "Alex" and no marker is Alex's too: a positive one a share, a
 * negative one something you owe.
 */
export function iouEntries(rows: IouRow[]): IouEntry[] {
  const out: IouEntry[] = [];
  for (const row of rows) {
    const marker = parseIouMarker(row.notes);
    const person = marker?.person ?? row.payee?.trim() ?? '';
    if (!person || /^transfer:/i.test(person) || /^starting balance/i.test(person)) continue;
    const kind: IouKind = marker?.kind ?? (row.amount >= 0 ? 'share' : 'owe');
    out.push({ ...row, person, kind, marker });
  }
  return out;
}

export interface PersonBalance {
  person: string;
  /** Positive: they owe you. Negative: you owe them. Minor units. */
  balance: number;
  /** Rows with them, newest first. */
  entries: IouEntry[];
  lastDate: string;
}

/** Each person's balance, people with money outstanding first, largest first. */
export function personBalances(entries: IouEntry[]): PersonBalance[] {
  const byKey = new Map<string, PersonBalance>();
  for (const e of entries) {
    const key = personKey(e.person);
    const current = byKey.get(key) ?? { person: e.person, balance: 0, entries: [], lastDate: '' };
    current.balance += e.amount;
    current.entries.push(e);
    if (e.date > current.lastDate) current.lastDate = e.date;
    byKey.set(key, current);
  }
  const list = [...byKey.values()];
  // Newest first; on one day a payment or a let-go follows what it settled,
  // so it reads above it.
  const after = (e: IouEntry) => (e.kind === 'settle' || e.kind === 'forgive' ? 1 : 0);
  for (const p of list) p.entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : after(b) - after(a)));
  return list.sort((a, b) =>
    Number(a.balance === 0) - Number(b.balance === 0)
    || Math.abs(b.balance) - Math.abs(a.balance)
    || (a.lastDate < b.lastDate ? 1 : -1));
}

export type ShareStatus = 'open' | 'part' | 'settled';

/**
 * How far each share is settled, oldest first: payments go to the oldest
 * share in the direction they settle. Shown only; nothing is stored per share.
 */
export function shareStatuses(entries: IouEntry[]): Map<string, { status: ShareStatus; left: number }> {
  const out = new Map<string, { status: ShareStatus; left: number }>();
  const oldestFirst = [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // What has come back towards shares owed to you, and gone towards ones you owe.
  let paidToYou = 0;
  let paidByYou = 0;
  for (const e of oldestFirst) {
    if (e.kind === 'settle' || e.kind === 'forgive') {
      if (e.amount < 0) paidToYou += -e.amount;
      else paidByYou += e.amount;
    }
  }
  for (const e of oldestFirst) {
    if (e.kind === 'share' && e.amount > 0) {
      const covered = Math.min(paidToYou, e.amount);
      paidToYou -= covered;
      const left = e.amount - covered;
      out.set(e.id, { status: left === 0 ? 'settled' : covered > 0 ? 'part' : 'open', left });
    } else if (e.kind === 'owe' && e.amount < 0) {
      const owed = -e.amount;
      const covered = Math.min(paidByYou, owed);
      paidByYou -= covered;
      const left = owed - covered;
      out.set(e.id, { status: left === 0 ? 'settled' : covered > 0 ? 'part' : 'open', left });
    }
  }
  return out;
}

/**
 * Split `total` (minor units) between `count` people as evenly as cents
 * allow, the odd cents to the first ones, so the parts always add back up.
 */
export function evenParts(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  let rest = total - base * count;
  return Array.from({ length: count }, () => base + (rest-- > 0 ? 1 : 0));
}

/** Parts in proportion to `weights` (shares, or percents), adding up to `total`. */
export function weightedParts(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map(w => (Math.max(0, w) / sum) * total);
  const floors = raw.map(Math.floor);
  let rest = total - floors.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i] += 1;
    rest -= 1;
  }
  return floors;
}

/** The input to hash for a share row's id: the same split writes the same row on any phone. */
export function shareRowHashInput(gid: string, person: string): string {
  return `arc-iou:${gid}:${personKey(person)}`;
}
