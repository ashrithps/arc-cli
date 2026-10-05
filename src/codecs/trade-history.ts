/**
 * Trade-history codec — a near-verbatim port of the arc app's
 * `utils/tradeHistory.ts`. Compatibility surface: the app writes this blob
 * and the CLI only reads it, so do not "tidy" the wire format.
 * tests/portfolio-history.test.ts pins the exact string the app emits.
 *
 * One note per investment account:
 *
 *   id:   portfolio-trades-{accountId}
 *   body: #trades:v1:<base64(JSON)>  →  { v:1, trades:[{ d, s, sd, r, f }] }
 *
 * The app appends on every activity sync (deduped by date+symbol+side+pnl).
 * The CLI never writes it — the encoder exists only for round-trip tests.
 *
 * Pure module — no client, no IO.
 */

/** A compact closed-trade record (all money in integer cents). */
export interface TradeRecord {
  /** YYYY-MM-DD */
  d: string;
  /** symbol */
  s: string;
  /** 'BUY' | 'SELL' */
  sd: 'BUY' | 'SELL';
  /** realizedPnlCents — signed, 0 for buys */
  r: number;
  /** commissionCents + taxesCents — magnitude */
  f: number;
}

export const TRADES_PREFIX = '#trades:v1:';

interface TradesBlob {
  v: 1;
  trades: TradeRecord[];
}

/** Encode trade records to a `#trades:v1:<base64>` line. */
export function encodeTradeHistory(trades: TradeRecord[]): string {
  const blob: TradesBlob = { v: 1, trades };
  return `${TRADES_PREFIX}${Buffer.from(JSON.stringify(blob)).toString('base64')}`;
}

/**
 * Decode a `#trades:v1:<base64>` line (or a multi-line note containing one).
 * Returns [] — never throws — if the line is absent or malformed.
 */
export function decodeTradeHistory(noteText: string | null | undefined): TradeRecord[] {
  if (!noteText) return [];

  const start = noteText.indexOf(TRADES_PREFIX);
  if (start < 0) return [];

  // Extract from the prefix to end-of-line (or end-of-string).
  const rest = noteText.slice(start + TRADES_PREFIX.length);
  const end = rest.indexOf('\n');
  const b64 = end >= 0 ? rest.slice(0, end) : rest;

  try {
    const blob: TradesBlob = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (blob.v !== 1 || !Array.isArray(blob.trades)) return [];
    return blob.trades;
  } catch {
    return [];
  }
}
