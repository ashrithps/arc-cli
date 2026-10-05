/**
 * Position-history codec — a near-verbatim port of the arc app's
 * `utils/positionHistory.ts`. Compatibility surface: the app writes these
 * shards and the CLI only reads them, so do not "tidy" the wire format.
 * tests/portfolio-history.test.ts pins the exact string the app emits.
 *
 * MONTH-SHARDED, one note per (account, month):
 *
 *   id:   portfolio-history-{accountId}-{YYYY-MM}
 *   body: #pfhist:v1:<base64(JSON)>  →  { v:1, days:[{ d, p:{symbol:cents} }] }
 *
 * Only the current month's shard is ever rewritten; past months are frozen,
 * which is the whole reason the app sharded. The app keeps
 * `HISTORY_CAP_MONTHS` shards and prunes older ones on accrual. Values are the
 * app's budget-currency cents (same units as `#hold`).
 *
 * The CLI never writes these — the encoder exists only for round-trip tests.
 *
 * Pure module — no client, no IO.
 */

export const PFHIST_PREFIX = '#pfhist:v1:';
const NOTE_PREFIX = 'portfolio-history-';

/** How many monthly shards the app retains (~5y). */
export const HISTORY_CAP_MONTHS = 60;

/** Extract the "YYYY-MM" from a month-shard note id (null if it doesn't match). */
export function ymOfNoteId(accountId: string, noteId: string): string | null {
  const prefix = `${NOTE_PREFIX}${accountId}-`;
  if (!noteId.startsWith(prefix)) return null;
  const ym = noteId.slice(prefix.length);
  return /^\d{4}-\d{2}$/.test(ym) ? ym : null;
}

/** One day's per-ticker values (symbol → market value in app-base cents). */
export interface HistoryDay {
  d: string; // YYYY-MM-DD
  p: Record<string, number>; // symbol -> value cents (may be negative for shorts)
}

interface PfHistBlob {
  v: 1;
  days: HistoryDay[];
}

/** A single point on a value-over-time series. */
export interface HistoryPoint {
  date: string; // YYYY-MM-DD
  value: number; // cents
}

/** Per-ticker move between the two most recent days. */
export interface Mover {
  symbol: string;
  delta: number; // cents (today value − previous value)
}

/**
 * Decode one month-shard note. Tolerates a bare line or a multi-line note.
 * Returns that month's days sorted ascending; [] if absent/malformed (no throw).
 */
export function decodePositionHistory(noteText: string | null | undefined): HistoryDay[] {
  if (!noteText) return [];
  try {
    const line = noteText
      .split('\n')
      .map(l => l.trim())
      .find(l => l.startsWith(PFHIST_PREFIX));
    if (!line) return [];
    const json = Buffer.from(line.slice(PFHIST_PREFIX.length), 'base64').toString('utf8');
    const blob = JSON.parse(json) as PfHistBlob;
    if (!blob || !Array.isArray(blob.days)) return [];
    return blob.days
      .filter(d => d && typeof d.d === 'string' && d.p && typeof d.p === 'object')
      .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  } catch {
    return [];
  }
}

/** Encode one month's days to a `#pfhist:v1:<base64>` line. */
export function encodePositionHistory(days: HistoryDay[]): string {
  const blob: PfHistBlob = { v: 1, days };
  return `${PFHIST_PREFIX}${Buffer.from(JSON.stringify(blob), 'utf8').toString('base64')}`;
}

/**
 * Decode + concatenate many month-shard notes into one ascending day series.
 * Dedupes by date (last wins) so overlapping shards never double-count.
 */
export function decodeAllMonths(noteTexts: Array<string | null | undefined>): HistoryDay[] {
  const byDate = new Map<string, HistoryDay>();
  for (const text of noteTexts) {
    for (const day of decodePositionHistory(text)) byDate.set(day.d, day);
  }
  return [...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

/** Per-ticker value series (ascending). Days where the symbol is absent are skipped. */
export function historySeriesForSymbol(days: HistoryDay[], symbol: string): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  for (const day of days) {
    const v = day.p[symbol];
    if (typeof v === 'number') out.push({ date: day.d, value: v });
  }
  return out;
}

/** Account-level series = sum of all ticker values per day (ascending). */
export function historyTotalSeries(days: HistoryDay[]): HistoryPoint[] {
  return days.map(day => ({
    date: day.d,
    value: Object.values(day.p).reduce((s, v) => s + v, 0),
  }));
}

/**
 * Per-ticker move between the two most recent days — "what moved today". Sorted by
 * magnitude (largest absolute move first). [] if fewer than 2 days. A symbol
 * present today but absent the prior day counts its full value as the move.
 */
export function topMovers(days: HistoryDay[], limit = 0): Mover[] {
  if (days.length < 2) return [];
  const today = days[days.length - 1];
  const prev = days[days.length - 2];
  const movers: Mover[] = Object.keys(today.p).map(symbol => ({
    symbol,
    delta: today.p[symbol] - (prev.p[symbol] ?? 0),
  }));
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return limit > 0 ? movers.slice(0, limit) : movers;
}
