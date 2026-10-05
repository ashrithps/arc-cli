/**
 * Portfolio history — realized P/L, dividends and the daily value series.
 *
 * The `portfolio` group reads the CURRENT state (`#investment:`, `#hold:v1:`,
 * `#act:` transactions). The arc app also keeps three history blobs, each in
 * its own note so it survives a device restore:
 *
 *   portfolio-trades-{accountId}             #trades:v1:   closed trades
 *   portfolio-dividends-{accountId}          #divs:v1:     dividends paid
 *   portfolio-history-{accountId}-{YYYY-MM}  #pfhist:v1:   per-ticker daily value
 *
 * Everything here is READ-ONLY. The app owns these notes and appends to them
 * on every brokerage sync; the history shards in particular are frozen once
 * their month ends, so a CLI write could only do damage.
 *
 * All money is integer CENTS. The win/loss maths mirrors the app's
 * `utils/tradeAnalytics.ts` but runs on the stored `TradeRecord`s directly.
 */
import type { ActualClient } from '../client.js';
import { readAllNotes, tradeNoteId, dividendNoteId, type NoteRow } from './notes.js';
import { decodeTradeHistory, type TradeRecord } from '../codecs/trade-history.js';
import { decodeDividendHistory } from '../codecs/dividend-history.js';
import {
  decodeAllMonths,
  historyTotalSeries,
  topMovers,
  ymOfNoteId,
  type HistoryDay,
  type HistoryPoint,
  type Mover,
} from '../codecs/position-history.js';

// ── Shared scoping ────────────────────────────────────────────────────────────

export interface HistoryRange {
  /** Already-resolved account UUID to scope to one investment account. */
  account?: string;
  /** Inclusive lower bound, YYYY-MM-DD. */
  from?: string;
  /** Inclusive upper bound, YYYY-MM-DD. */
  to?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkRange({ from, to }: HistoryRange): void {
  if (from !== undefined && !DATE_RE.test(from)) throw new Error(`--from must be YYYY-MM-DD, got "${from}"`);
  if (to !== undefined && !DATE_RE.test(to)) throw new Error(`--to must be YYYY-MM-DD, got "${to}"`);
  if (from && to && from > to) throw new Error(`--from (${from}) is after --to (${to})`);
}

function inRange(date: string, { from, to }: HistoryRange): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

interface ScopedAccount {
  id: string;
  name: string;
}

/**
 * The notes table plus the accounts in scope. Notes whose account no longer
 * exists are ignored — the app reads these blobs by account id, so an orphan
 * left behind by a deleted account is invisible there too.
 */
async function loadScope(
  client: ActualClient,
  range: HistoryRange,
): Promise<{ notes: NoteRow[]; accounts: ScopedAccount[] }> {
  client.ensureConnected();
  checkRange(range);
  const [notes, all] = await Promise.all([readAllNotes(client), client.api.getAccounts()]);
  const accounts = (all as any[])
    .filter(a => !range.account || a.id === range.account)
    .map(a => ({ id: a.id as string, name: a.name as string }));
  return { notes, accounts };
}

function bodyOf(notes: NoteRow[], id: string): string | null {
  return notes.find(n => n.id === id)?.note ?? null;
}

// ── Win/loss maths (cents) ────────────────────────────────────────────────────

/** Summary stats for a set of closed trades. All money in cents. */
export interface WinLossStats {
  /** Number of trades that closed (sells only — buys open, sells close). */
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  /** winningTrades / totalTrades (0 if no trades). */
  winRate: number;
  /** Average realized P/L of winners (cents, >0); 0 if none. */
  avgWinnerCents: number;
  /** Average realized P/L of losers as a magnitude (cents, >0); 0 if none. */
  avgLoserCents: number;
  grossGainCents: number;
  /** Magnitude. */
  grossLossCents: number;
  /** grossGain / grossLoss. Infinity if no losses, 0 if neither. */
  profitFactor: number;
  netRealizedCents: number;
  /** Commission + tax across ALL trades, buys included. */
  totalFeesCents: number;
  largestGainCents: number;
  /** Magnitude. */
  largestLossCents: number;
  /** avgWinner / avgLoser. Infinity if no losers, 0 if no winners. */
  payoffRatio: number;
}

/**
 * Same rules as the app's `computeWinLossStats`: only SELLs close a position,
 * so only SELLs count toward win/loss; fees are summed over every trade.
 */
export function computeWinLossStats(trades: TradeRecord[]): WinLossStats {
  const sells = trades.filter(t => t.sd === 'SELL');
  const winners = sells.filter(t => t.r > 0);
  const losers = sells.filter(t => t.r < 0);

  const totalTrades = sells.length;
  const winningTrades = winners.length;
  const losingTrades = losers.length;

  const grossGainCents = winners.reduce((s, t) => s + t.r, 0);
  const grossLossCents = losers.reduce((s, t) => s + Math.abs(t.r), 0);

  const avgWinnerCents = winningTrades > 0 ? Math.round(grossGainCents / winningTrades) : 0;
  const avgLoserCents = losingTrades > 0 ? Math.round(grossLossCents / losingTrades) : 0;

  const profitFactor = grossLossCents > 0
    ? grossGainCents / grossLossCents
    : grossGainCents > 0 ? Infinity : 0;

  const payoffRatio = avgLoserCents > 0
    ? avgWinnerCents / avgLoserCents
    : avgWinnerCents > 0 ? Infinity : 0;

  return {
    totalTrades,
    winningTrades,
    losingTrades,
    breakevenTrades: totalTrades - winningTrades - losingTrades,
    winRate: totalTrades > 0 ? winningTrades / totalTrades : 0,
    avgWinnerCents,
    avgLoserCents,
    grossGainCents,
    grossLossCents,
    profitFactor,
    netRealizedCents: sells.reduce((s, t) => s + t.r, 0),
    totalFeesCents: trades.reduce((s, t) => s + t.f, 0),
    largestGainCents: winners.length > 0 ? Math.max(...winners.map(t => t.r)) : 0,
    largestLossCents: losers.length > 0 ? Math.max(...losers.map(t => Math.abs(t.r))) : 0,
    payoffRatio,
  };
}

/** The app's profit-factor tier label (Van Tharp tiers). */
export function winLossTier(stats: WinLossStats): string {
  if (stats.totalTrades === 0) return 'No trades';
  if (stats.profitFactor === Infinity) return 'Perfect';
  if (stats.profitFactor >= 2) return 'Great edge';
  if (stats.profitFactor >= 1.5) return 'Solid edge';
  if (stats.profitFactor >= 1) return 'Break-even';
  if (stats.profitFactor >= 0.5) return 'Weak edge';
  return 'Losing';
}

// ── Realized P/L ──────────────────────────────────────────────────────────────

export type RealizedPeriod = 'month' | 'year';

export interface RealizedOptions extends HistoryRange {
  /** Bucket size for `byPeriod`. Default 'month'. */
  period?: RealizedPeriod;
}

export interface RealizedTrade {
  date: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  /** Realized P/L in cents (0 for buys). */
  realized: number;
  /** Commission + tax in cents. */
  fees: number;
  accountId: string;
  account: string;
}

export interface RealizedGroup {
  key: string;
  /** Closing (SELL) trades in the bucket. */
  closed: number;
  wins: number;
  losses: number;
  /** Net realized P/L of the bucket's sells, cents. */
  realized: number;
  /** Fees on every trade in the bucket, cents. */
  fees: number;
}

/**
 * `WinLossStats` made JSON-safe: `JSON.stringify(Infinity)` is `null` anyway,
 * so say it outright — null means "no losses to divide by".
 */
export type RealizedStats = Omit<WinLossStats, 'profitFactor' | 'payoffRatio'> & {
  profitFactor: number | null;
  payoffRatio: number | null;
};

export interface RealizedReport {
  from?: string;
  to?: string;
  period: RealizedPeriod;
  stats: RealizedStats;
  tier: string;
  bySymbol: RealizedGroup[];
  byPeriod: RealizedGroup[];
  byAccount: RealizedGroup[];
  /** Newest first. */
  trades: RealizedTrade[];
}

const finiteOrNull = (n: number): number | null => (Number.isFinite(n) ? n : null);

function groupTrades(trades: RealizedTrade[], keyFn: (t: RealizedTrade) => string): RealizedGroup[] {
  const map = new Map<string, RealizedGroup>();
  for (const t of trades) {
    const key = keyFn(t);
    const g = map.get(key) ?? { key, closed: 0, wins: 0, losses: 0, realized: 0, fees: 0 };
    g.fees += t.fees;
    if (t.side === 'SELL') {
      g.closed += 1;
      g.realized += t.realized;
      if (t.realized > 0) g.wins += 1;
      else if (t.realized < 0) g.losses += 1;
    }
    map.set(key, g);
  }
  return [...map.values()];
}

/** Realized P/L from the app's `#trades:v1:` history, by symbol, period and account. */
export async function realized(
  client: ActualClient,
  opts: RealizedOptions = {},
): Promise<RealizedReport> {
  const period = opts.period ?? 'month';
  if (period !== 'month' && period !== 'year') {
    throw new Error(`--period must be month or year, got "${period}"`);
  }
  const { notes, accounts } = await loadScope(client, opts);

  const records: TradeRecord[] = [];
  const trades: RealizedTrade[] = [];
  for (const acct of accounts) {
    for (const t of decodeTradeHistory(bodyOf(notes, tradeNoteId(acct.id)))) {
      if (!t || typeof t.d !== 'string' || !inRange(t.d, opts)) continue;
      const r = Number(t.r) || 0;
      const f = Number(t.f) || 0;
      records.push({ ...t, r, f });
      trades.push({
        date: t.d,
        symbol: t.s ?? '',
        side: t.sd,
        realized: r,
        fees: f,
        accountId: acct.id,
        account: acct.name,
      });
    }
  }
  trades.sort((a, b) => b.date.localeCompare(a.date));

  const stats = computeWinLossStats(records);
  const periodKey = (t: RealizedTrade) => t.date.slice(0, period === 'year' ? 4 : 7);
  const byRealized = (a: RealizedGroup, b: RealizedGroup) => b.realized - a.realized;

  return {
    from: opts.from,
    to: opts.to,
    period,
    stats: {
      ...stats,
      profitFactor: finiteOrNull(stats.profitFactor),
      payoffRatio: finiteOrNull(stats.payoffRatio),
    },
    tier: winLossTier(stats),
    bySymbol: groupTrades(trades, t => t.symbol).sort(byRealized),
    byPeriod: groupTrades(trades, periodKey).sort((a, b) => a.key.localeCompare(b.key)),
    byAccount: groupTrades(trades, t => t.account).sort(byRealized),
    trades,
  };
}

// ── Dividends ─────────────────────────────────────────────────────────────────

export interface DividendRow {
  date: string;
  /** '' when the broker reported no symbol. */
  symbol: string;
  /** Cents, positive. */
  amount: number;
  accountId: string;
  account: string;
}

export interface DividendTotal {
  key: string;
  count: number;
  /** Cents. */
  total: number;
}

export interface DividendReport {
  from?: string;
  to?: string;
  /** Cents. */
  total: number;
  count: number;
  /** Largest first. */
  bySymbol: DividendTotal[];
  /** Ascending by year. */
  byYear: DividendTotal[];
  byAccount: DividendTotal[];
  /** Newest first. */
  rows: DividendRow[];
}

function totalBy(rows: DividendRow[], keyFn: (r: DividendRow) => string): DividendTotal[] {
  const map = new Map<string, DividendTotal>();
  for (const r of rows) {
    const key = keyFn(r);
    const t = map.get(key) ?? { key, count: 0, total: 0 };
    t.count += 1;
    t.total += r.amount;
    map.set(key, t);
  }
  return [...map.values()];
}

/** Dividends from the app's `#divs:v1:` history, with totals by symbol, year and account. */
export async function dividends(
  client: ActualClient,
  opts: HistoryRange = {},
): Promise<DividendReport> {
  const { notes, accounts } = await loadScope(client, opts);

  const rows: DividendRow[] = [];
  for (const acct of accounts) {
    for (const d of decodeDividendHistory(bodyOf(notes, dividendNoteId(acct.id)))) {
      if (!d || typeof d.d !== 'string' || !inRange(d.d, opts)) continue;
      rows.push({
        date: d.d,
        symbol: d.s ?? '',
        amount: Number(d.a) || 0,
        accountId: acct.id,
        account: acct.name,
      });
    }
  }
  rows.sort((a, b) => b.date.localeCompare(a.date));

  const byTotal = (a: DividendTotal, b: DividendTotal) => b.total - a.total;
  return {
    from: opts.from,
    to: opts.to,
    total: rows.reduce((s, r) => s + r.amount, 0),
    count: rows.length,
    bySymbol: totalBy(rows, r => r.symbol).sort(byTotal),
    byYear: totalBy(rows, r => r.date.slice(0, 4)).sort((a, b) => a.key.localeCompare(b.key)),
    byAccount: totalBy(rows, r => r.account).sort(byTotal),
    rows,
  };
}

// ── Daily value series ────────────────────────────────────────────────────────

/**
 * Sum several per-account series into one. Each account contributes its most
 * recent known value at every date that appears in ANY series (0 before its
 * first point). Same forward-fill rule as the app's `mergeBalanceHistories`.
 * Inputs must be ascending.
 */
export function mergeSeries(series: HistoryPoint[][]): HistoryPoint[] {
  const nonEmpty = series.filter(s => s.length > 0);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return nonEmpty[0];

  const dates = [...new Set(nonEmpty.flatMap(s => s.map(p => p.date)))].sort();
  const idx = nonEmpty.map(() => 0);
  const last = nonEmpty.map(() => 0);
  const out: HistoryPoint[] = [];

  for (const date of dates) {
    let sum = 0;
    nonEmpty.forEach((s, i) => {
      while (idx[i] < s.length && s[idx[i]].date <= date) {
        last[i] = s[idx[i]].value;
        idx[i] += 1;
      }
      sum += last[i];
    });
    out.push({ date, value: sum });
  }
  return out;
}

export interface HistoryAccountSummary {
  accountId: string;
  account: string;
  /** Month shards found (YYYY-MM, ascending). */
  months: string[];
  /** Days inside the requested range. */
  days: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Value on `lastDate`, cents. */
  latestValue: number | null;
  /** Largest per-ticker moves between the last two days in range. */
  movers: Mover[];
}

export interface HistoryReport {
  from?: string;
  to?: string;
  /** Daily total value across the scoped accounts, cents, ascending. */
  series: HistoryPoint[];
  /** First → last point of `series`; null with fewer than 2 points. */
  change: { start: number; end: number; delta: number } | null;
  accounts: HistoryAccountSummary[];
}

/** Number of top movers reported per account. */
const MOVER_LIMIT = 5;

/**
 * Daily value series from the app's month-sharded `#pfhist:v1:` notes, merged
 * across shards and then across accounts. Accounts are merged on their full
 * history before the range is applied, so an account that did not change
 * inside the window still contributes its last known value.
 */
export async function history(
  client: ActualClient,
  opts: HistoryRange = {},
): Promise<HistoryReport> {
  const { notes, accounts } = await loadScope(client, opts);
  const historyNotes = notes.filter(n => n.id.startsWith('portfolio-history-'));

  const perAccount: HistoryPoint[][] = [];
  const summaries: HistoryAccountSummary[] = [];
  for (const acct of accounts) {
    const shards = historyNotes
      .map(n => ({ ym: ymOfNoteId(acct.id, n.id), note: n.note }))
      .filter((s): s is { ym: string; note: string } => s.ym !== null)
      .sort((a, b) => a.ym.localeCompare(b.ym));
    if (shards.length === 0) continue;

    const allDays = decodeAllMonths(shards.map(s => s.note));
    if (allDays.length === 0) continue;
    perAccount.push(historyTotalSeries(allDays));

    const days: HistoryDay[] = allDays.filter(d => inRange(d.d, opts));
    const total = historyTotalSeries(days);
    summaries.push({
      accountId: acct.id,
      account: acct.name,
      months: shards.map(s => s.ym),
      days: days.length,
      firstDate: days[0]?.d ?? null,
      lastDate: days[days.length - 1]?.d ?? null,
      latestValue: total.length > 0 ? total[total.length - 1].value : null,
      movers: topMovers(days, MOVER_LIMIT),
    });
  }

  const series = mergeSeries(perAccount).filter(p => inRange(p.date, opts));
  const change = series.length >= 2
    ? {
        start: series[0].value,
        end: series[series.length - 1].value,
        delta: series[series.length - 1].value - series[0].value,
      }
    : null;

  return { from: opts.from, to: opts.to, series, change, accounts: summaries };
}
