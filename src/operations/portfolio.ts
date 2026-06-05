/**
 * Portfolio operations for Actual Budget.
 *
 * Investment data lives entirely inside the Actual budget — there is NO
 * external brokerage API at read time. Two on-budget conventions carry it:
 *
 *   1. **Account notes** (the `notes` AQL table, keyed by account UUID) hold a
 *      machine-readable `#investment:` line that marks an account as an
 *      investment account, plus an optional `#hold:v1:<base64>` line that
 *      encodes the current holdings snapshot (a `CompactPosition[]`).
 *
 *   2. **Transactions** tagged `#act:<kind>` form the trade / activity ledger.
 *      Trades may live on the investment (portfolio) account itself OR on its
 *      paired cash account (the `paired:` UUID from the `#investment:` line),
 *      so we read both and dedupe by transaction id.
 *
 * Everything here is READ-ONLY. Money values decoded from the holdings blob
 * and from transactions are integer CENTS (minor units), matching the rest of
 * arc — callers divide by 100 / reuse `formatCurrency` for display.
 *
 * This mirrors the encoding written by the arc mobile app (the same
 * `#investment:` / `#hold:v1:` / `#act:` wire format), so all surfaces agree.
 */
import type { ActualClient } from '../client.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type InvestmentType = 'stock' | 'crypto';
export type InvestmentMode = 'simple' | 'detailed';
export type AssetClass =
  | 'STK' | 'ETF' | 'FUND' | 'OPT' | 'CRYPTO' | 'BOND' | 'CASH';

export interface InvestmentMeta {
  /** Account UUID (the holdings/portfolio account). */
  accountId: string;
  /** Resolved account name. */
  accountName: string;
  type: InvestmentType;
  /** Paired cash account UUID (where buy/sell cash legs land), if any. */
  pairedAccountId?: string;
  mode: InvestmentMode;
  /** Data source: manual | ibkr_flex | screenshot | … */
  src?: string;
  /** Last-known snapshot date (YYYY-MM-DD), if present. */
  asOf?: string;
  /** Whether the `act:1` (active) flag is set. */
  active: boolean;
  /** The raw account note (for downstream holdings parsing). */
  note: string;
}

/** A decoded holding (all money fields are integer CENTS). */
export interface Position {
  symbol: string;
  assetClass: AssetClass;
  quantity: number;
  currency: string;
  /** Market price per unit, in cents. */
  markPrice: number;
  /** Market value, in cents. */
  marketValue: number;
  /** Cost basis per unit, in cents (if known). */
  costBasisPrice?: number;
  /** Total cost basis money, in cents (if known). */
  costBasisMoney?: number;
  /** Unrealized P/L, in cents (if known). */
  unrealizedPnl?: number;
  /** Previous close, in cents (if known). */
  prevClose?: number;
  /** Day change percent (number, e.g. 1.2 for +1.2%). */
  dayPct?: number;
  name?: string;
  exchange?: string;
  conid?: string | number;
  optRight?: 'C' | 'P';
  optStrike?: number;
  optExpiry?: string;
  multiplier?: number;
}

export type TradeKind =
  | 'buy' | 'sell' | 'commission' | 'fee' | 'tax'
  | 'realized' | 'dividend' | 'interest' | 'deposit' | 'withdrawal' | 'other';

export interface Trade {
  id: string;
  date: string;
  /** Symbol token parsed from the START of the note (may be empty). */
  symbol: string;
  kind: TradeKind;
  /** Note with the `#act:<kind>` token stripped and trailing ` |` cleaned. */
  detail: string;
  /** Amount in integer CENTS (Actual minor units). */
  amount: number;
  account: string;
  accountId: string;
}

export interface HoldingRow extends Position {
  /** Unrealized P/L as a percent of cost basis (number, e.g. 12.5). */
  unrealizedPnlPct?: number;
  accountId: string;
  account: string;
}

// ── #investment: / #hold:v1: parsing ───────────────────────────────────────────
//
// Ported verbatim from the arc mobile app so the wire format stays in lockstep.

const INVESTMENT_LINE = /#investment:/;

/**
 * Parse the `#investment:` metadata out of an account note. Exported for unit
 * tests; production callers go through `getInvestmentAccounts`.
 */
export function parseInvestmentLine(note: string): Omit<InvestmentMeta, 'accountId' | 'accountName' | 'note'> | null {
  if (!INVESTMENT_LINE.test(note)) return null;
  const type = (note.match(/#investment:(stock|crypto)/)?.[1] as InvestmentType) ?? 'stock';
  const pairedAccountId = note.match(/\|paired:([a-f0-9-]+)/)?.[1];
  const mode = (note.match(/\|mode:(simple|detailed)/)?.[1] as InvestmentMode) ?? 'simple';
  const src = note.match(/\|src:([a-z0-9_-]+)/)?.[1];
  const asOf = note.match(/\|asOf:(\d{4}-\d{2}-\d{2})/)?.[1];
  const active = /\|act:1\b/.test(note);
  return { type, pairedAccountId, mode, src, asOf, active };
}

/** Short-key compact wire shape written by the mobile app's #hold encoder. */
interface CompactPosition {
  s: string;
  ac: AssetClass;
  q: number;
  cur: string;
  p: number;
  mv: number;
  cb?: number;
  cbp?: number;
  upnl?: number;
  pc?: number;
  dp?: number;
  n?: string;
  ex?: string;
  cid?: string | number;
  or?: 'C' | 'P';
  os?: number;
  oe?: string;
  mul?: number;
}

function expandCompact(c: CompactPosition): Position {
  return {
    symbol: c.s,
    assetClass: c.ac,
    quantity: c.q,
    currency: c.cur,
    markPrice: c.p,
    marketValue: c.mv,
    costBasisMoney: c.cb,
    costBasisPrice: c.cbp,
    unrealizedPnl: c.upnl,
    prevClose: c.pc,
    dayPct: c.dp,
    name: c.n,
    exchange: c.ex,
    conid: c.cid,
    optRight: c.or,
    optStrike: c.os,
    optExpiry: c.oe,
    multiplier: c.mul,
  };
}

/**
 * Decode the `#hold:v1:<base64>` line of an account note into positions.
 * Returns null (never throws) when the line is absent or malformed.
 */
export function parseHoldings(note: string): Position[] | null {
  if (!note) return null;
  const line = note
    .split('\n')
    .map(l => l.trim())
    .find(l => l.startsWith('#hold:v1:'));
  if (!line) return null;
  try {
    const b64 = line.slice('#hold:v1:'.length);
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as CompactPosition[];
    if (!Array.isArray(parsed)) return null;
    return parsed.map(expandCompact);
  } catch {
    return null;
  }
}

// ── Account-note discovery (the `notes` AQL table) ──────────────────────────────

interface NoteRow {
  id: string;
  note: string;
}

/** Strip an optional `account-` prefix to recover the bare account UUID. */
function noteIdToAccountId(id: string): string {
  return id.replace(/^account-/, '');
}

async function readNotes(client: ActualClient): Promise<NoteRow[]> {
  const res: any = await client.api.aqlQuery(
    client.api.q('notes').select(['id', 'note']),
  );
  const rows: Array<{ id: string; note: string }> = res?.data ?? [];
  return rows.filter(r => r && typeof r.note === 'string' && r.note.includes('#investment:'));
}

// ── Investment account discovery ────────────────────────────────────────────────

/**
 * Return every DETAILED investment account in the active budget, joined with
 * its parsed `#investment:` metadata and resolved name. Only accounts whose
 * note carries `#investment:` are considered investment accounts.
 */
export async function getInvestmentAccounts(client: ActualClient): Promise<InvestmentMeta[]> {
  client.ensureConnected();
  const [noteRows, accounts] = await Promise.all([
    readNotes(client),
    client.api.getAccounts(),
  ]);
  const nameById = new Map<string, string>(
    accounts.map((a: any) => [a.id, a.name]),
  );

  const metas: InvestmentMeta[] = [];
  for (const row of noteRows) {
    const accountId = noteIdToAccountId(row.id);
    const parsed = parseInvestmentLine(row.note);
    if (!parsed) continue;
    // Skip orphaned notes whose account no longer exists (a deleted account that
    // left its #investment note behind) — they'd otherwise show as a bare UUID.
    const accountName = nameById.get(accountId);
    if (accountName === undefined) continue;
    metas.push({
      accountId,
      accountName,
      note: row.note,
      ...parsed,
    });
  }
  return metas;
}

function isDetailed(m: InvestmentMeta): boolean {
  return m.mode === 'detailed';
}

// ── Holdings ────────────────────────────────────────────────────────────────────

function withPnlPct(p: Position): HoldingRow {
  const cost = p.costBasisMoney
    ?? (p.costBasisPrice != null ? Math.round(p.costBasisPrice * p.quantity) : undefined);
  let unrealizedPnlPct: number | undefined;
  if (p.unrealizedPnl != null && cost != null && cost !== 0) {
    unrealizedPnlPct = (p.unrealizedPnl / Math.abs(cost)) * 100;
  }
  return { ...p, unrealizedPnlPct } as HoldingRow;
}

/**
 * List holdings across all DETAILED investment accounts (or one account when
 * `accountId` is given). Each row is a `Position` augmented with its account
 * and an unrealized-P/L percent.
 */
export async function listHoldings(
  client: ActualClient,
  accountId?: string,
): Promise<HoldingRow[]> {
  client.ensureConnected();
  const metas = (await getInvestmentAccounts(client)).filter(isDetailed);
  const scoped = accountId ? metas.filter(m => m.accountId === accountId) : metas;

  const rows: HoldingRow[] = [];
  for (const meta of scoped) {
    const positions = parseHoldings(meta.note);
    if (!positions) continue;
    for (const p of positions) {
      const row = withPnlPct(p);
      row.accountId = meta.accountId;
      row.account = meta.accountName;
      rows.push(row);
    }
  }
  return rows;
}

export interface HoldingDetail {
  holding: HoldingRow;
  /** Allocation % of this holding's market value vs. its account's total. */
  allocationPct: number;
  trades: Trade[];
}

/**
 * Detail for a single holding (matched by symbol, case-insensitive). Includes
 * allocation % within its account plus its trade ledger (same data as
 * `listTrades({ symbol })`). Returns null if no matching holding is found.
 */
export async function getHolding(
  client: ActualClient,
  symbol: string,
  accountId?: string,
): Promise<HoldingDetail | null> {
  client.ensureConnected();
  const holdings = await listHoldings(client, accountId);
  const needle = symbol.toLowerCase();
  const holding = holdings.find(h => h.symbol.toLowerCase() === needle);
  if (!holding) return null;

  // Allocation within the holding's own account.
  const sameAccount = holdings.filter(h => h.accountId === holding.accountId);
  const accountTotal = sameAccount.reduce((s, h) => s + (h.marketValue || 0), 0);
  const allocationPct = accountTotal !== 0
    ? (holding.marketValue / accountTotal) * 100
    : 0;

  const trades = await listTrades(client, { symbol, account: holding.accountId });
  return { holding, allocationPct, trades };
}

// ── Trades / activity ledger ────────────────────────────────────────────────────

const ACT_TOKEN = /#act:(buy|sell|commission|fee|tax|realized|dividend|interest|deposit|withdrawal|other)/;

/** Clean a trade note for display: strip `#act:<kind>` and any trailing ` |`. */
function cleanTradeDetail(note: string): string {
  return note
    .replace(/#act:\w+/g, '')
    .replace(/\s*\|\s*$/, '')
    .trim();
}

/**
 * The symbol is embedded at the START of the note, e.g.
 *   "AMZN  280121C00220000 Sell -1 @ 81.33 #act:sell"  → "AMZN"
 *   "SOL Buy 5 @ 70.00 #act:buy"                        → "SOL"
 * We take the first whitespace-delimited token.
 */
function symbolFromNote(note: string): string {
  const first = (note || '').trim().split(/\s+/)[0] ?? '';
  return first.startsWith('#') ? '' : first;
}

const OUTFLOW_KINDS = new Set<TradeKind>(['buy', 'commission', 'fee', 'tax', 'withdrawal']);
const INFLOW_KINDS = new Set<TradeKind>(['sell', 'dividend', 'interest', 'deposit']);

/**
 * Normalize a transfer leg's signed amount to a cash-direction sign by kind, so
 * a buy/cost reads negative and a sell/income reads positive regardless of which
 * leg (portfolio vs cash) we kept. `realized`/`other` keep their raw sign.
 */
function normalizeTradeAmount(kind: TradeKind, amount: number): number {
  const abs = Math.abs(amount);
  if (OUTFLOW_KINDS.has(kind)) return -abs;
  if (INFLOW_KINDS.has(kind)) return abs;
  return amount;
}

export interface TradeOptions {
  symbol?: string;
  /** Already-resolved account UUID to scope to one investment account. */
  account?: string;
  kind?: TradeKind;
  start?: string;
  end?: string;
}

/**
 * The trade / activity ledger. For each in-scope investment account AND its
 * paired cash account we pull transactions, keep those tagged `#act:<kind>`,
 * and dedupe by transaction id (a trade may appear on both accounts).
 */
export async function listTrades(
  client: ActualClient,
  opts: TradeOptions = {},
): Promise<Trade[]> {
  client.ensureConnected();
  const { symbol, account, kind, start, end } = opts;

  const metas = await getInvestmentAccounts(client);
  const scopedMetas = account ? metas.filter(m => m.accountId === account) : metas;

  const accounts = await client.api.getAccounts();
  const nameById = new Map<string, string>(accounts.map((a: any) => [a.id, a.name]));

  // Build the set of (accountId → owning investment account) pairs to scan:
  // the portfolio account itself plus its paired cash account. We attribute a
  // trade to the portfolio account regardless of which side it was found on.
  const scanTargets: Array<{ scanId: string; ownerId: string; ownerName: string }> = [];
  const seenScan = new Set<string>();
  for (const meta of scopedMetas) {
    for (const id of [meta.accountId, meta.pairedAccountId].filter(Boolean) as string[]) {
      const key = `${meta.accountId}:${id}`;
      if (seenScan.has(key)) continue;
      seenScan.add(key);
      scanTargets.push({ scanId: id, ownerId: meta.accountId, ownerName: meta.accountName });
    }
  }

  const needle = symbol?.toLowerCase();
  const byId = new Map<string, Trade>();

  for (const target of scanTargets) {
    let txns: any[];
    try {
      txns = await (client.api as any).getTransactions(target.scanId, start, end);
    } catch {
      continue;
    }
    for (const t of txns) {
      const note: string = t.notes ?? '';
      const m = note.match(ACT_TOKEN);
      if (!m) continue;
      const k = m[1] as TradeKind;
      if (kind && k !== kind) continue;
      const sym = symbolFromNote(note);
      // Substring match is fine — searching "AMZN" matches "AMZN  280121C...".
      if (needle && !note.toLowerCase().includes(needle)) continue;
      if (byId.has(t.id)) continue;
      // Buy/sell legs are TRANSFERS. In Actual a transfer's `transfer_id` holds
      // the COUNTERPART leg's id (not a shared group id), so if we've already
      // kept the counterpart, this is the mirror leg — skip it.
      const transferId: string | undefined = t.transfer_id ?? undefined;
      if (transferId && byId.has(transferId)) continue;
      byId.set(t.id, {
        id: t.id,
        date: t.date,
        symbol: sym,
        kind: k,
        detail: cleanTradeDetail(note),
        amount: normalizeTradeAmount(k, t.amount ?? 0),
        accountId: target.ownerId,
        account: nameById.get(target.ownerId) ?? target.ownerName,
      });
    }
  }

  const trades = [...byId.values()];
  trades.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return trades;
}

// ── Summary ─────────────────────────────────────────────────────────────────────

export interface AllocationSlice {
  key: string;
  marketValue: number;
  pct: number;
}

export interface PortfolioSummary {
  totalMarketValue: number;
  totalUnrealizedPnl: number;
  byAccount: AllocationSlice[];
  byAssetClass: AllocationSlice[];
}

function allocate(
  rows: HoldingRow[],
  keyFn: (r: HoldingRow) => string,
  total: number,
): AllocationSlice[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(keyFn(r), (map.get(keyFn(r)) ?? 0) + (r.marketValue || 0));
  }
  return [...map.entries()]
    .map(([key, marketValue]) => ({
      key,
      marketValue,
      pct: total !== 0 ? (marketValue / total) * 100 : 0,
    }))
    .sort((a, b) => b.marketValue - a.marketValue);
}

/** Total market value, total unrealized P/L, and allocation breakdowns. */
export async function getSummary(client: ActualClient): Promise<PortfolioSummary> {
  client.ensureConnected();
  const holdings = await listHoldings(client);
  const totalMarketValue = holdings.reduce((s, h) => s + (h.marketValue || 0), 0);
  const totalUnrealizedPnl = holdings.reduce((s, h) => s + (h.unrealizedPnl || 0), 0);
  return {
    totalMarketValue,
    totalUnrealizedPnl,
    byAccount: allocate(holdings, h => h.account, totalMarketValue),
    byAssetClass: allocate(holdings, h => h.assetClass, totalMarketValue),
  };
}

// ── Accounts ────────────────────────────────────────────────────────────────────

export interface PortfolioAccount {
  accountId: string;
  name: string;
  /** Investment kind from the #investment line: stock | crypto. */
  type: InvestmentType;
  mode: InvestmentMode;
  src: string;
  /** Total market value (cents). For detailed accounts only; 0 otherwise. */
  value: number;
}

/**
 * Investment accounts with their kind (stock/crypto), tracking mode
 * (simple/detailed), data source, and total market value (for detailed
 * accounts the sum of holdings market values; simple accounts report 0).
 */
export async function getPortfolioAccounts(client: ActualClient): Promise<PortfolioAccount[]> {
  client.ensureConnected();
  const metas = await getInvestmentAccounts(client);
  const rows: PortfolioAccount[] = [];
  for (const meta of metas) {
    let value = 0;
    if (isDetailed(meta)) {
      const positions = parseHoldings(meta.note);
      if (positions) value = positions.reduce((s, p) => s + (p.marketValue || 0), 0);
    }
    rows.push({
      accountId: meta.accountId,
      name: meta.accountName,
      type: meta.type,
      mode: meta.mode,
      src: meta.src ?? 'manual',
      value,
    });
  }
  return rows;
}
