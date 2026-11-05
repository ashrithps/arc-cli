// Ported near-verbatim from the arc app (budgetarc utils/debtTag.ts, 1.0.49).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * The `#debt|` tag in an account's note: what arc knows about a card, loan or
 * BNPL plan (docs/specs/debt-cycle.md §1). Pure: the one reader and writer of
 * the line for every path (DebtTagService, the Accounts sheets, the CLI port).
 *
 *   #debt|due:5|stmt:18|kind:card|limit:30000000|rate:42|min:5%/20000|region:IN
 *
 * A key this build doesn't know is kept as written, after the ones it does, so
 * a newer arc's fields survive an edit here. A known key with a bad value is
 * dropped on read and so gone at the next write.
 */

export const DEBT_TAG_PREFIX = '#debt|';

export type DebtKind = 'card' | 'loan' | 'bnpl';
export type LoanKind = 'home' | 'car' | 'personal' | 'education' | 'other';
export type BnplEvery = '1w' | '2w' | '1m';

export type MinRule =
  | { kind: 'percent'; percent: number; floor: number | null }
  | { kind: 'all' };

export type Autopay =
  | { kind: 'none' }
  | { kind: 'min' }
  | { kind: 'full' }
  | { kind: 'fixed'; amount: number };

export interface DebtTag {
  dueDay: number | null;
  statementDay: number | null;
  kind: DebtKind;
  /** Minor units of the card's currency. */
  limit: number | null;
  /** Yearly %. */
  rate: number | null;
  rateType: 'fixed' | 'float' | null;
  min: MinRule | null;
  autopay: Autopay;
  /** ISO 3166-1 alpha-2, upper case. */
  region: string | null;
  /** ISO 4217, upper case. */
  currency: string | null;
  /** YYYY-MM-DD. */
  promoEnds: string | null;
  loanKind: LoanKind | null;
  emi: number | null;
  /** YYYY-MM. */
  start: string | null;
  term: number | null;
  principal: number | null;
  instalments: number | null;
  every: BnplEvery | null;
  /** YYYY-MM-DD. */
  first: string | null;
  /** The learned due day was offered and declined. */
  askDeclined: boolean;
  /** Fields this build doesn't know, as written ("key:value"). */
  other: string[];
}

export const EMPTY_DEBT_TAG: DebtTag = Object.freeze({
  dueDay: null,
  statementDay: null,
  kind: 'card',
  limit: null,
  rate: null,
  rateType: null,
  min: null,
  autopay: { kind: 'none' },
  region: null,
  currency: null,
  promoEnds: null,
  loanKind: null,
  emi: null,
  start: null,
  term: null,
  principal: null,
  instalments: null,
  every: null,
  first: null,
  askDeclined: false,
  other: [],
}) as DebtTag;

// The write order (spec §1), `due` first.
const KNOWN = [
  'due', 'stmt', 'kind', 'limit', 'rate', 'ratetype', 'min', 'autopay', 'region', 'cur', 'promo',
  'lkind', 'emi', 'start', 'term', 'principal', 'n', 'every', 'first', 'ask',
] as const;
const KNOWN_SET = new Set<string>(KNOWN);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

function dayOfMonth(value: string): number | null {
  if (!/^\d{1,2}$/.test(value)) return null;
  const n = parseInt(value, 10);
  return n >= 1 && n <= 31 ? n : null;
}

function minorUnits(value: string): number | null {
  if (!/^\d{1,15}$/.test(value)) return null;
  return parseInt(value, 10);
}

function count(value: string): number | null {
  if (!/^\d{1,4}$/.test(value)) return null;
  const n = parseInt(value, 10);
  return n > 0 ? n : null;
}

function percent(value: string): number | null {
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(value)) return null;
  const n = parseFloat(value);
  return n >= 0 && n <= 999 ? n : null;
}

function realDate(value: string): boolean {
  if (!DAY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function parseMin(value: string): MinRule | null {
  if (value === 'all') return { kind: 'all' };
  const m = /^(\d{1,3}(?:\.\d{1,4})?)%(?:\/(\d{1,15}))?$/.exec(value);
  if (!m) return null;
  const pct = parseFloat(m[1]);
  if (!(pct > 0 && pct <= 100)) return null;
  return { kind: 'percent', percent: pct, floor: m[2] ? parseInt(m[2], 10) : null };
}

function parseAutopay(value: string): Autopay | null {
  if (value === 'none' || value === 'min' || value === 'full') return { kind: value };
  const m = /^fixed\/(\d{1,15})$/.exec(value);
  return m ? { kind: 'fixed', amount: parseInt(m[1], 10) } : null;
}

/** The note's `#debt|` line, trimmed; the first wins. */
export function findDebtLine(note: string | null | undefined): string | null {
  if (!note) return null;
  return note.split('\n').map((l) => l.trim()).find((l) => l.startsWith(DEBT_TAG_PREFIX)) ?? null;
}

/** The tag in a note, or null when it has none. */
export function parseDebtNote(note: string | null | undefined): DebtTag | null {
  const line = findDebtLine(note);
  return line ? parseDebtLine(line) : null;
}

export function parseDebtLine(line: string): DebtTag {
  const tag: DebtTag = { ...EMPTY_DEBT_TAG, autopay: { kind: 'none' }, other: [] };
  const seen = new Set<string>();
  for (const field of line.split('|').slice(1)) {
    if (!field) continue;
    const colon = field.indexOf(':');
    const key = colon < 0 ? field : field.slice(0, colon);
    const value = colon < 0 ? '' : field.slice(colon + 1);
    if (!KNOWN_SET.has(key)) {
      tag.other.push(field);
      continue;
    }
    // A key written twice: the first stands, as `due` always did.
    if (seen.has(key)) continue;
    seen.add(key);
    switch (key) {
      case 'due': tag.dueDay = dayOfMonth(value); break;
      case 'stmt': tag.statementDay = dayOfMonth(value); break;
      case 'kind': if (value === 'card' || value === 'loan' || value === 'bnpl') tag.kind = value; break;
      case 'limit': tag.limit = minorUnits(value); break;
      case 'rate': tag.rate = percent(value); break;
      case 'ratetype': if (value === 'fixed' || value === 'float') tag.rateType = value; break;
      case 'min': tag.min = parseMin(value); break;
      case 'autopay': tag.autopay = parseAutopay(value) ?? { kind: 'none' }; break;
      case 'region': if (/^[A-Za-z]{2}$/.test(value)) tag.region = value.toUpperCase(); break;
      case 'cur': if (/^[A-Za-z]{3}$/.test(value)) tag.currency = value.toUpperCase(); break;
      case 'promo': if (realDate(value)) tag.promoEnds = value; break;
      case 'lkind':
        if (value === 'home' || value === 'car' || value === 'personal' || value === 'education' || value === 'other') tag.loanKind = value;
        break;
      case 'emi': tag.emi = minorUnits(value); break;
      case 'start': if (MONTH.test(value) && realDate(`${value}-01`)) tag.start = value; break;
      case 'term': tag.term = count(value); break;
      case 'principal': tag.principal = minorUnits(value); break;
      case 'n': tag.instalments = count(value); break;
      case 'every': if (value === '1w' || value === '2w' || value === '1m') tag.every = value; break;
      case 'first': if (realDate(value)) tag.first = value; break;
      case 'ask': tag.askDeclined = value === 'no'; break;
    }
  }
  return tag;
}

function numberText(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

function minText(min: MinRule): string {
  if (min.kind === 'all') return 'all';
  return `${numberText(min.percent)}%${min.floor != null ? `/${Math.round(min.floor)}` : ''}`;
}

function autopayText(autopay: Autopay): string | null {
  if (autopay.kind === 'none') return null;
  return autopay.kind === 'fixed' ? `fixed/${Math.round(autopay.amount)}` : autopay.kind;
}

/** The line for a tag, keys in the spec's order, unknown ones last. */
export function serializeDebtTag(tag: DebtTag): string {
  const fields: string[] = [`due:${tag.dueDay ?? ''}`];
  const put = (key: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined || value === '') return;
    fields.push(`${key}:${value}`);
  };
  put('stmt', tag.statementDay);
  // Card is what a tag without `kind` means: older builds wrote none.
  if (tag.kind !== 'card') put('kind', tag.kind);
  put('limit', tag.limit != null ? Math.round(tag.limit) : null);
  put('rate', tag.rate != null ? numberText(tag.rate) : null);
  put('ratetype', tag.rateType);
  put('min', tag.min ? minText(tag.min) : null);
  put('autopay', autopayText(tag.autopay));
  put('region', tag.region);
  put('cur', tag.currency);
  put('promo', tag.promoEnds);
  put('lkind', tag.loanKind);
  put('emi', tag.emi != null ? Math.round(tag.emi) : null);
  put('start', tag.start);
  put('term', tag.term);
  put('principal', tag.principal != null ? Math.round(tag.principal) : null);
  put('n', tag.instalments);
  put('every', tag.every);
  put('first', tag.first);
  if (tag.askDeclined) put('ask', 'no');
  return [DEBT_TAG_PREFIX.slice(0, -1), ...fields, ...tag.other].join('|');
}

/** Nothing worth a line: no due day and nothing else set. */
export function isEmptyDebtTag(tag: DebtTag): boolean {
  return serializeDebtTag(tag) === serializeDebtTag(EMPTY_DEBT_TAG);
}

/**
 * The note with its `#debt|` line replaced by `tag` (or removed for null or an
 * empty tag), every other line kept in place.
 */
export function noteWithDebtTag(note: string | null | undefined, tag: DebtTag | null): string | null {
  const lines = (note || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(DEBT_TAG_PREFIX));
  if (tag && !isEmptyDebtTag(tag)) lines.push(serializeDebtTag(tag));
  const merged = lines.join('\n').trim();
  return merged.length > 0 ? merged : null;
}
