import chalk from 'chalk';

// ── Brand Colors ──────────────────────────────────────────────
export const colors = {
  primary: chalk.hex('#6C5CE7'),
  secondary: chalk.hex('#00CEC9'),
  accent: chalk.hex('#FD79A8'),
  success: chalk.hex('#00B894'),
  warning: chalk.hex('#FDCB6E'),
  error: chalk.hex('#E17055'),
  muted: chalk.hex('#636E72'),
  dim: chalk.hex('#2D3436'),
  credit: chalk.hex('#00B894'),
  debit: chalk.hex('#E17055'),
  transfer: chalk.hex('#74B9FF'),
  header: chalk.hex('#DFE6E9'),
};

// ── Symbols ───────────────────────────────────────────────────
export const sym = {
  dot: '●',
  circle: '○',
  arrow: '→',
  check: '✓',
  cross: '✗',
  dash: '─',
  pipe: '│',
  corner: '└',
  tee: '├',
  star: '★',
  money: '$',
  up: '▲',
  down: '▼',
  bullet: '•',
  spark: '⚡',
  lock: '🔒',
  unlock: '🔓',
  bank: '🏦',
  card: '💳',
  chart: '📊',
  calendar: '📅',
  pin: '📌',
};

// ── Formatters ────────────────────────────────────────────────
// Arc only talks to Actual Budget, which is currency-agnostic — it stores
// every amount as an integer in minor units (amount / 100) regardless of the
// user's actual currency. We deliberately do NOT emit a currency symbol in
// CLI output, because guessing wrong ($, ₹, €, £, …) silently misleads the
// user and any agent that parses the output. Callers that know their
// currency can pass a symbol explicitly.
export function formatAmount(cents: number, symbol: string = ''): string {
  const abs = Math.abs(cents / 100);
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const str = `${symbol}${formatted}`;
  if (cents > 0) return colors.credit('+' + str);
  if (cents < 0) return colors.debit('-' + str);
  return colors.muted(str);
}

export function badge(text: string, color: typeof chalk = colors.primary): string {
  return color(` ${text} `);
}

export function divider(width: number = 60): string {
  return colors.dim(sym.dash.repeat(width));
}

export function header(text: string): string {
  const line = sym.dash.repeat(Math.max(0, 56 - text.length));
  return `\n${colors.primary(sym.dot)} ${chalk.bold.white(text)} ${colors.dim(line)}`;
}

export function subheader(text: string): string {
  return `  ${colors.secondary(sym.arrow)} ${chalk.white(text)}`;
}

export function row(label: string, value: string, indent: number = 2): string {
  const pad = ' '.repeat(indent);
  return `${pad}${colors.muted(label.padEnd(20))} ${value}`;
}

export function statusDot(status: 'ok' | 'warn' | 'error' | 'info'): string {
  const colorMap = { ok: colors.success, warn: colors.warning, error: colors.error, info: colors.primary };
  return colorMap[status](sym.dot);
}
