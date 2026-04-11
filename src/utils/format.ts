/**
 * Convert cents (integer) to human-readable amount.
 * 1234 → 12.34, -5000 → -50.00
 */
export function centsToAmount(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Convert human amount to cents (integer).
 * 12.34 → 1234, -50 → -5000
 */
export function amountToCents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Format cents as a signed decimal amount string, without any currency
 * symbol by default. Arc only talks to Actual Budget, which is currency-
 * agnostic, so we must not assume the user's currency. Callers that know
 * their currency can pass a symbol explicitly.
 *
 *   1234   → "12.34"
 *   -5000  → "-50.00"
 *   1234, "$" → "$12.34"  (caller-supplied symbol)
 */
export function formatCurrency(cents: number, symbol: string = ''): string {
  const abs = Math.abs(centsToAmount(cents));
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cents < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
}

/**
 * Validate and normalize a date string to YYYY-MM-DD.
 */
export function formatDate(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid date format: "${date}". Expected YYYY-MM-DD.`);

  const [, y, m, d] = match;
  const parsed = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (isNaN(parsed.getTime())) throw new Error(`Invalid date: "${date}"`);

  return `${y}-${m}-${d}`;
}

/**
 * Validate and normalize a month string to YYYY-MM.
 */
export function formatMonth(month: string): string {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error(`Invalid month format: "${month}". Expected YYYY-MM.`);
  return month;
}

/**
 * Convert YYYY-MM-DD to Actual's integer format (20260331).
 */
export function dateToActual(date: string): number {
  return parseInt(date.replace(/-/g, ''), 10);
}

/**
 * Convert Actual's integer date (20260331) to YYYY-MM-DD.
 */
export function actualToDate(num: number): string {
  const s = String(num);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * Print rows as an aligned table to console.
 */
export function printTable(rows: Record<string, any>[], columns?: string[]): void {
  if (rows.length === 0) {
    console.log('(no data)');
    return;
  }

  const cols = columns || Object.keys(rows[0]);
  const widths: Record<string, number> = {};

  for (const col of cols) {
    widths[col] = col.length;
    for (const row of rows) {
      const val = String(row[col] ?? '');
      widths[col] = Math.max(widths[col], val.length);
    }
  }

  // Header
  const header = cols.map(c => c.padEnd(widths[c])).join(' | ');
  const separator = cols.map(c => '-'.repeat(widths[c])).join('-+-');
  console.log(header);
  console.log(separator);

  // Rows
  for (const row of rows) {
    const line = cols.map(c => {
      const val = String(row[c] ?? '');
      return val.padEnd(widths[c]);
    }).join(' | ');
    console.log(line);
  }

  console.log(`\n${rows.length} row(s)`);
}

/**
 * Print data as JSON.
 */
export function printJson(data: any): void {
  console.log(JSON.stringify(data, null, 2));
}
