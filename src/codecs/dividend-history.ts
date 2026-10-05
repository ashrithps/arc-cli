/**
 * Dividend-history codec — a near-verbatim port of the arc app's
 * `utils/dividendHistory.ts`. Compatibility surface: the app writes this blob
 * and the CLI only reads it, so do not "tidy" the wire format.
 * tests/portfolio-history.test.ts pins the exact string the app emits.
 *
 * One note per investment account:
 *
 *   id:   portfolio-dividends-{accountId}
 *   body: #divs:v1:<base64(JSON)>  →  { v:1, dividends:[{ d, s, a }] }
 *
 * The CLI never writes it — the encoder exists only for round-trip tests.
 *
 * Pure module — no client, no IO.
 */

/** A compact dividend record. */
export interface DividendRecord {
  /** YYYY-MM-DD */
  d: string;
  /** symbol that paid the dividend ('' when the broker gave none) */
  s: string;
  /** amount in cents (positive) */
  a: number;
}

export const DIVS_PREFIX = '#divs:v1:';

interface DivsBlob {
  v: 1;
  dividends: DividendRecord[];
}

/** Encode dividend records to a `#divs:v1:<base64>` line. */
export function encodeDividendHistory(dividends: DividendRecord[]): string {
  const blob: DivsBlob = { v: 1, dividends };
  return `${DIVS_PREFIX}${Buffer.from(JSON.stringify(blob)).toString('base64')}`;
}

/**
 * Decode a `#divs:v1:<base64>` line (or a multi-line note containing one).
 * Returns [] — never throws — if the line is absent or malformed.
 */
export function decodeDividendHistory(noteText: string | null | undefined): DividendRecord[] {
  if (!noteText) return [];

  const start = noteText.indexOf(DIVS_PREFIX);
  if (start < 0) return [];

  const rest = noteText.slice(start + DIVS_PREFIX.length);
  const end = rest.indexOf('\n');
  const b64 = end >= 0 ? rest.slice(0, end) : rest;

  try {
    const blob: DivsBlob = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (blob.v !== 1 || !Array.isArray(blob.dividends)) return [];
    return blob.dividends;
  } catch {
    return [];
  }
}
