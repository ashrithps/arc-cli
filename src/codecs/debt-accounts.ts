// Ported from the arc app (budgetarc 1.0.49): utils/debtAccounts.ts,
// utils/debtPaySource.ts, utils/accountTypeLabel.ts (accountTypeKey) and the
// type guess in utils/accountMatch.ts (inferAccountType). Keep in step.
/**
 * Which accounts are debt (docs/specs/debt-cycle.md §1.1). A tag says so
 * whatever the balance; an untagged account owing money is a card or a loan
 * when its type or its place says it is (off budget, owing, is a loan); any
 * other account below zero is overdrawn, never debt: out of debt totals,
 * progress and the debt-free date.
 *
 * Some accounts are never debt, tag or not: the IOUs account (what's owed
 * between people lives in Splits), an investment account and its cash (a
 * margin balance is the broker's ledger, not a loan to remind about), and a
 * thing you own (`#asset:`). Their ids come from `nonDebtAccountIdsFrom`; the
 * IOUs name and the investment types catch them without it.
 */
import type { DebtKind, DebtTag } from './debt-tag.js';

// ── accountTypeKey (utils/accountTypeLabel.ts) ──────────────────────────────

export type AccountTypeKey =
  | 'checking' | 'savings' | 'credit' | 'investment' | 'mortgage' | 'other' | 'stockCrypto';

const STORED: Record<string, AccountTypeKey> = {
  savings: 'savings',
  credit: 'credit',
  creditcard: 'credit',
  credit_card: 'credit',
  investment: 'investment',
  mortgage: 'mortgage',
  debt: 'mortgage',
  loan: 'mortgage',
  stock_crypto: 'stockCrypto',
  other: 'other',
};

const SYNONYMS: ReadonlyArray<[RegExp, string]> = [
  [/\bamerican\s+express\b/g, 'amex'],
  [/\bbank\s+of\s+america\b/g, 'bofa'],
  [/\bcapital\s+one\b/g, 'capitalone'],
  [/\bcap\s+one\b/g, 'capitalone'],
  [/\bwells\s+fargo\b/g, 'wellsfargo'],
  [/\bmaster\s*card\b/g, 'mastercard'],
];

function normalizeName(name: string | null | undefined): string {
  let s = (name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ');
  for (const [pattern, replacement] of SYNONYMS) s = s.replace(pattern, replacement);
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

const CREDIT_WORDS = /\b(credit|amex|platinum|sapphire|freedom|venture|quicksilver|savor|reserve|rewards|cashback|signature|infinite|world elite)\b/i;
const DEBIT_WORDS = /\b(debit|checking|chequing|current)\b/i;
const SAVINGS_WORDS = /\b(savings?|saver|isa)\b/i;

/** inferAccountType(name, 'inbox'): the name decides when it can. */
function inferAccountType(name: string): 'credit' | 'checking' | 'savings' | 'other' {
  const folded = normalizeName(name);
  if (SAVINGS_WORDS.test(folded)) return 'savings';
  if (DEBIT_WORDS.test(folded)) return 'checking';
  if (CREDIT_WORDS.test(folded)) return 'credit';
  return 'other';
}

export function accountTypeKey(account: { type?: string | null; name?: string | null }): AccountTypeKey {
  const stored = (account.type ?? '').toLowerCase();
  if (STORED[stored]) return STORED[stored];
  const inferred = inferAccountType(account.name ?? '');
  return inferred === 'credit' || inferred === 'savings' ? inferred : 'checking';
}

// ── debtAccounts ────────────────────────────────────────────────────────────

/** utils/iouLedger.ts */
export const IOU_ACCOUNT_TAG = '#iou:v1';
export const IOU_ACCOUNT_DEFAULT_NAME = 'IOUs';

export interface DebtClassifiable {
  id: string;
  name: string;
  type?: string | null;
  balance: number;
  offbudget?: boolean | number | null;
  closed?: boolean | number | null;
}

export type DebtClass = { kind: DebtKind } | { kind: 'overdrawn' } | null;

const IOU_NAME = IOU_ACCOUNT_DEFAULT_NAME.toLowerCase();

/** Never debt and never overdrawn: Splits' IOUs, an investment and its cash. */
export function isNeverDebt(account: Pick<DebtClassifiable, 'id' | 'name' | 'type'>, notDebt?: ReadonlySet<string>): boolean {
  if (notDebt?.has(account.id)) return true;
  if ((account.name ?? '').trim().toLowerCase() === IOU_NAME) return true;
  const type = accountTypeKey(account);
  return type === 'investment' || type === 'stockCrypto';
}

export function debtClassOf(account: DebtClassifiable, tag: DebtTag | null | undefined, notDebt?: ReadonlySet<string>): DebtClass {
  if (account.closed || isNeverDebt(account, notDebt)) return null;
  if (tag) return { kind: tag.kind };
  if (!(account.balance < 0)) return null;
  const type = accountTypeKey(account);
  if (type === 'credit') return { kind: 'card' };
  if (type === 'mortgage' || account.offbudget) return { kind: 'loan' };
  return { kind: 'overdrawn' };
}

export const isDebt = (c: DebtClass): c is { kind: DebtKind } => !!c && c.kind !== 'overdrawn';

/**
 * services/nonDebtAccounts.ts over the notes table: every investment account
 * (`#investment:`) and its paired cash account, the IOUs account by its note
 * tag, and every thing you own (`#asset:` line).
 */
export function nonDebtAccountIdsFrom(notes: ReadonlyArray<{ id: string; note: string }>): Set<string> {
  const ids = new Set<string>();
  for (const { id, note } of notes) {
    if (!id.startsWith('account-') || typeof note !== 'string') continue;
    const accountId = id.slice('account-'.length);
    if (note.includes(IOU_ACCOUNT_TAG)) ids.add(accountId);
    for (const line of note.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#asset:')) ids.add(accountId);
      if (trimmed.startsWith('#investment:')) {
        ids.add(accountId);
        // The paired cash account (`|paired:<uuid>`, as operations/portfolio.ts reads it).
        const paired = /\|paired:([a-f0-9-]+)/.exec(trimmed);
        if (paired) ids.add(paired[1]);
      }
    }
  }
  return ids;
}

// ── debtPaySource ───────────────────────────────────────────────────────────

/** Types that are owed or invested, never what a debt is paid from. */
const NOT_A_PAYER = new Set(['credit', 'mortgage', 'investment', 'stockCrypto']);

export function canPayDebtFrom(
  account: DebtClassifiable,
  debtAccountId: string,
  taggedDebtIds: ReadonlySet<string>,
  notDebt?: ReadonlySet<string>,
): boolean {
  if (account.id === debtAccountId || account.closed || account.offbudget) return false;
  if (taggedDebtIds.has(account.id) || isNeverDebt(account, notDebt)) return false;
  return !NOT_A_PAYER.has(accountTypeKey(account));
}

/**
 * `lastPaidFromId`: the account of the newest transfer into this debt, if any.
 * Returns the paying account, or null to leave the field for the person.
 */
export function debtPaySourceOf<A extends DebtClassifiable>(
  accounts: ReadonlyArray<A>,
  debtAccountId: string,
  lastPaidFromId: string | null,
  taggedDebtIds: ReadonlySet<string>,
  notDebt?: ReadonlySet<string>,
): A | null {
  const ok = (a: A) => canPayDebtFrom(a, debtAccountId, taggedDebtIds, notDebt);
  const last = lastPaidFromId ? accounts.find((a) => a.id === lastPaidFromId) : undefined;
  if (last && ok(last)) return last;
  return accounts.find(ok) ?? null;
}
