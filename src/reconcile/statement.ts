/**
 * Statement reconciliation — "is this statement line already in my budget?"
 *
 * Ported near-verbatim from the app's `services/statementReconciliationService.ts`
 * so the CLI and the app agree on what matches. The only structural change:
 * the app reaches into its SQLite mirror with a lazy `require('./Database')`;
 * here the two functions that did that take a `LedgerSource` as their first
 * argument instead (see `./adapter.ts`).
 *
 * Units follow the app: statement-side amounts are MAJOR units (the shape a
 * parsed statement arrives in), ledger rows are minor units. The operation
 * layer (`src/operations/reconciliation.ts`) converts at the edge.
 */
import type { DBTransaction, LedgerSource } from './adapter.js';

export interface CurrencyRule {
  id: string;
  currencyCode: string;
  rate: number;
  accountId: string;
}

export interface ImportedStatementTransaction {
  account: string;
  type?: 'expense' | 'income' | 'transfer';
  amount: number;
  payee?: string;
  category?: string;
  notes?: string;
  date?: string;
  subtransactions?: unknown[];
}

export interface AccountInfo {
  id: string;
  name: string;
  type?: string;
}

export type ReconciliationConfidence = 'high' | 'medium' | 'ambiguous';

export interface StatementReconciliationMatch {
  existingTransaction: DBTransaction;
  confidence: ReconciliationConfidence;
  score: number;
  merchantScore: number;
  existingAccountCurrencyAmount: number | null;
  statementAccountCurrencyAmount: number;
  existingStoredAmount: number;
  statementStoredAmount: number;
  dateDistanceDays: number;
  reasons: string[];
}

export interface ReconciledTransactionUpdate {
  type: 'expense' | 'income';
  amount: number;
  notes?: string;
  category?: string;
  merchant?: string;
  date?: string;
}

export interface StatementBalanceMetadata {
  account?: string;
  statementStartDate?: string | null;
  statementEndDate?: string | null;
  openingBalance?: number | null;
  closingBalance?: number | null;
  balanceCurrency?: string | null;
}

export type StatementBalancePointKind = 'opening' | 'closing';

export interface StatementBalancePoint {
  kind: StatementBalancePointKind;
  date: string;
  statementAmount: number;
  statementCents: number;
  ledgerCents: number;
  differenceCents: number;
  matches: boolean;
  unavailableReason?: string;
}

export interface StatementBalanceComparison {
  account: AccountInfo;
  currencyCode: string;
  opening: StatementBalancePoint | null;
  closing: StatementBalancePoint | null;
  matches: boolean;
  unavailableReasons: string[];
}

export interface StatementImportSubmitPlan<T> {
  rowsToSubmit: T[];
  duplicateCount: number;
  importableCount: number;
  allRowsAreDuplicates: boolean;
}

interface FindOptions {
  excludeIndices?: Set<number>;
  dateWindowDays?: number;
  payeeAliases?: Map<string, string[]>;
  // Ledger transaction ids already reconciled by a prior pass; never reconcile them again (M8).
  claimedTransactionIds?: Iterable<string>;
}

// Strip only the app's own FX prefix: a formatted amount (currency symbols, ISO codes and
// digits — never lowercase letters) immediately before "(FX rate: N)". The old lazy `.+?`
// consumed any text up to the first "(FX rate:", deleting user content such as
// "dinner, bank applied (FX rate: 0.27) per receipt". Requiring a digit and forbidding
// lowercase before the marker keeps the match anchored to app-generated prefixes.
const APP_FX_PREFIX_PATTERN = /^\s*[^a-z]*\d[^a-z]*?\(FX [Rr]ate:\s*[0-9.]+\)\s*(?:[•|-]\s*)?/;
// Capture the amount immediately preceding "(FX rate:" (optionally separated by an ISO code),
// not the first digit run in the note, so "... total 53.26 (FX rate: …)" yields 53.26.
const APP_FX_AMOUNT_PATTERN = /([\d,]+(?:\.\d+)?)\s*[A-Z]{0,4}\s*\(FX [Rr]ate:/;
const SHORTCUT_AUTO_CONVERTED_PATTERN = /\[auto-converted:\s*([A-Z]{3})\s+([\d,]+(?:\.\d+)?)\s*(?:→|->)\s*([A-Z]{3})\s+([\d,]+(?:\.\d+)?)(?:,\s*rate:\s*([\d.]+))?[^\]]*\]/i;
const CURRENCY_WORD_PATTERN = /\b[A-Z]{3}\b/g;
const WEAK_PAYEES = new Set(['', 'unknown', 'merchant', 'pending', 'transaction']);
const MERCHANT_NOISE_WORDS = new Set([
  // Payment-rail / processor noise
  'aeps',
  'apple',
  'bank',
  'card',
  'credit',
  'debit',
  'imps',
  'marketplace',
  'mastercard',
  'neft',
  'online',
  'pay',
  'payment',
  'pos',
  'purchase',
  'restaurant',
  'service',
  'services',
  'store',
  'upi',
  'visa',
  // Corporate / legal-entity suffixes — carry no merchant identity, so the bank's
  // "PVR Cinemas" and an estimate's "Pvr Limited" should collapse to the same brand.
  'company',
  'corp',
  'gmbh',
  'inc',
  'limited',
  'llc',
  'llp',
  'ltd',
  'plc',
  'private',
  'pvt',
]);

interface ShortcutFxContext {
  sourceCurrency: string;
  sourceAmount: number;
  targetCurrency: string;
  estimatedTargetAmount: number;
  estimatedRate: number | null;
}

function calculateBaseAmount(foreignAmount: number, rate: number): number {
  return foreignAmount * rate;
}

// A currency rule is only usable for conversion when its rate is finite and positive. Guards
// against a user-entered 0/negative/NaN rate writing a degenerate amount over a real
// transaction (calculateBaseAmount itself is unguarded; callers must screen the rate first).
function isUsableRate(rate: number | null | undefined): boolean {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
}

function amountToCents(amount: number): number {
  return Math.round(amount * 100);
}

function isCreditAccount(account: AccountInfo): boolean {
  return account.type?.toLowerCase() === 'credit';
}

function normalizeStatementBalanceCents(amount: number, account: AccountInfo): number {
  const cents = amountToCents(amount);
  // Credit accounts store debt as a negative ledger balance. A statement reports the amount
  // owed as a positive number (and a credit/overpaid balance as negative), so negate to the
  // ledger convention while PRESERVING sign — an overpaid card stays positive (H5).
  return isCreditAccount(account) ? -cents : cents;
}

function convertLedgerCentsForStatementCurrency(
  ledgerCents: number,
  currencyRule?: CurrencyRule,
): number {
  if (!currencyRule || !isUsableRate(currencyRule.rate)) return ledgerCents;

  // The ledger already carries the correct sign (credit debt negative, overpaid card positive);
  // only convert the currency. Forcing -abs here was asymmetric with the statement side and
  // collapsed genuine sign disagreements (H5).
  const statementAmount = (ledgerCents / 100) / currencyRule.rate;
  return amountToCents(statementAmount);
}

function buildBalancePoint(
  kind: StatementBalancePointKind,
  date: string | null | undefined,
  statementAmount: number | null | undefined,
  ledgerCents: number,
  account: AccountInfo,
  currencyRule?: CurrencyRule,
): StatementBalancePoint | null {
  if (!date) return null;
  if (typeof statementAmount !== 'number' || !Number.isFinite(statementAmount)) return null;

  const statementCents = normalizeStatementBalanceCents(statementAmount, account);
  const comparableLedgerCents = convertLedgerCentsForStatementCurrency(ledgerCents, currencyRule);
  const differenceCents = comparableLedgerCents - statementCents;

  return {
    kind,
    date,
    statementAmount,
    statementCents,
    ledgerCents: comparableLedgerCents,
    differenceCents,
    matches: Math.abs(differenceCents) <= 1,
  };
}

export function compareStatementBalances(
  metadata: StatementBalanceMetadata,
  account: AccountInfo,
  openingLedgerCents: number,
  closingLedgerCents: number,
  currencyRule?: CurrencyRule,
): StatementBalanceComparison {
  const unavailableReasons: string[] = [];
  if (!metadata.statementStartDate) unavailableReasons.push('missing statement start date');
  if (!metadata.statementEndDate) unavailableReasons.push('missing statement end date');
  if (typeof metadata.openingBalance !== 'number') unavailableReasons.push('missing opening balance');
  if (typeof metadata.closingBalance !== 'number') unavailableReasons.push('missing closing balance');

  const opening = buildBalancePoint(
    'opening',
    metadata.statementStartDate,
    metadata.openingBalance,
    openingLedgerCents,
    account,
    currencyRule,
  );
  const closing = buildBalancePoint(
    'closing',
    metadata.statementEndDate,
    metadata.closingBalance,
    closingLedgerCents,
    account,
    currencyRule,
  );

  return {
    account,
    currencyCode: currencyRule?.currencyCode || metadata.balanceCurrency || 'base',
    opening,
    closing,
    matches: Boolean(opening?.matches && closing?.matches),
    unavailableReasons,
  };
}

export function findStatementBalanceComparison(
  database: LedgerSource,
  metadata: StatementBalanceMetadata | null | undefined,
  accounts: AccountInfo[],
  currencyRules: CurrencyRule[] = [],
  pendingDeltaCents: number = 0,
): StatementBalanceComparison | null {
  if (!metadata?.account || !metadata.statementStartDate || !metadata.statementEndDate) return null;
  if (typeof metadata.openingBalance !== 'number' && typeof metadata.closingBalance !== 'number') return null;

  const account = accounts.find(a => a.name === metadata.account);
  if (!account) return null;

  const currencyRule = currencyRules.find(rule => rule.accountId === account.id);
  const openingLedgerCents = database.getAccountBalanceAsOf(account.id, metadata.statementStartDate, false);
  const closingLedgerCents = database.getAccountBalanceAsOf(account.id, metadata.statementEndDate, true) + pendingDeltaCents;

  return compareStatementBalances(
    metadata,
    account,
    openingLedgerCents,
    closingLedgerCents,
    currencyRule,
  );
}

export function getStatementImportSubmitPlan<T>(
  rows: T[],
  duplicateIndices: Set<number>,
  shouldSkipDuplicates: boolean,
): StatementImportSubmitPlan<T> {
  const rowsToSubmit = shouldSkipDuplicates
    ? rows.filter((_, index) => !duplicateIndices.has(index))
    : rows;

  return {
    rowsToSubmit,
    duplicateCount: duplicateIndices.size,
    importableCount: rowsToSubmit.length,
    allRowsAreDuplicates: rows.length > 0 && rowsToSubmit.length === 0 && duplicateIndices.size > 0,
  };
}

function formatReconciledFxNote(userNote: string, foreignAmount: number, rule: CurrencyRule): string {
  let formattedForeignAmount: string;
  try {
    formattedForeignAmount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: rule.currencyCode,
    }).format(foreignAmount).replace(/\u00a0/g, ' ');
  } catch {
    formattedForeignAmount = `${rule.currencyCode}${foreignAmount.toFixed(2)}`;
  }

  const codeAlreadyInFormat = formattedForeignAmount.toUpperCase().includes(rule.currencyCode.toUpperCase());
  const currencyInfo = codeAlreadyInFormat
    ? `${formattedForeignAmount} (FX rate: ${rule.rate})`
    : `${formattedForeignAmount} ${rule.currencyCode} (FX rate: ${rule.rate})`;

  return userNote ? `${currencyInfo} • ${userNote}` : currencyInfo;
}

function parseAmount(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseFloat(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
}

function extractAppFxAmount(notes: string | null | undefined): number | null {
  if (!notes) return null;
  const match = notes.match(APP_FX_AMOUNT_PATTERN);
  return parseAmount(match?.[1]);
}

function extractShortcutConvertedTargetAmount(notes: string | null | undefined): number | null {
  if (!notes) return null;
  const match = notes.match(SHORTCUT_AUTO_CONVERTED_PATTERN);
  return parseAmount(match?.[4]);
}

function extractShortcutFxContext(notes: string | null | undefined): ShortcutFxContext | null {
  if (!notes) return null;
  const match = notes.match(SHORTCUT_AUTO_CONVERTED_PATTERN);
  if (!match) return null;

  const sourceAmount = parseAmount(match[2]);
  const estimatedTargetAmount = parseAmount(match[4]);
  if (sourceAmount === null || estimatedTargetAmount === null) return null;

  return {
    sourceCurrency: match[1].toUpperCase(),
    sourceAmount,
    targetCurrency: match[3].toUpperCase(),
    estimatedTargetAmount,
    estimatedRate: match[5] ? parseFloat(match[5]) : null,
  };
}

function hasFxMetadata(notes: string | null | undefined): boolean {
  return Boolean(notes && (APP_FX_AMOUNT_PATTERN.test(notes) || SHORTCUT_AUTO_CONVERTED_PATTERN.test(notes)));
}

export function stripStaleFxMetadata(note: string | null | undefined): string {
  if (!note) return '';

  let cleaned = note.trim();
  cleaned = cleaned.replace(APP_FX_PREFIX_PATTERN, '').trim();
  cleaned = cleaned.replace(SHORTCUT_AUTO_CONVERTED_PATTERN, '').trim();
  cleaned = cleaned.replace(/^\s*[•|-]\s*/, '').replace(/\s*[•|-]\s*$/, '').trim();
  cleaned = cleaned.replace(/\s*•\s*•\s*/g, ' • ').trim();

  return cleaned;
}

function normalizeMerchant(value: string | null | undefined): string {
  if (!value) return '';
  const raw = value
    .toLowerCase()
    .replace(/transfer:\s*/g, ' ')
    .replace(/[*/|:_-]+/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return raw
    .split(' ')
    .filter(token => token.length >= 2 && !MERCHANT_NOISE_WORDS.has(token))
    .join(' ');
}

// Looser key used only as a fallback when normalizeMerchant() strips a payee to empty (all
// noise words, non-Latin scripts, or numeric UPI handles). Keeps noise words, digits and any
// Unicode letters; only non-alphanumeric separators collapse to spaces.
function looseNormalizeMerchant(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(value: string): string[] {
  return normalizeMerchant(value).split(' ').filter(token => token.length >= 3);
}

function tokenPrefixMatch(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }

  return previous[b.length];
}

export function scoreMerchantMatch(importedPayee: string | null | undefined, existingPayee: string | null | undefined): number {
  let imported = normalizeMerchant(importedPayee);
  let existing = normalizeMerchant(existingPayee);
  // H1: when either payee strips to empty, fall back to the looser key so noise-word-only or
  // non-Latin payees ("Apple Pay", Devanagari names, UPI handles) can still reconcile instead
  // of silently scoring 0. Amount/date/sign gates still apply, so this stays low-risk.
  if (!imported || !existing) {
    imported = looseNormalizeMerchant(importedPayee);
    existing = looseNormalizeMerchant(existingPayee);
  }
  if (!imported || !existing) return 0;
  if (imported === existing) return 1;
  if (imported.includes(existing) || existing.includes(imported)) return 0.9;

  const importedTokens = tokens(imported);
  const existingTokens = tokens(existing);
  const importedSet = new Set(importedTokens);
  const existingSet = new Set(existingTokens);
  const overlap = [...importedSet].filter(importedToken => (
    [...existingSet].some(existingToken => (
      importedToken === existingToken || tokenPrefixMatch(importedToken, existingToken)
    ))
  )).length;
  const shorterTokenCount = Math.min(importedSet.size, existingSet.size);
  const union = new Set([...importedTokens, ...existingTokens]).size;
  const tokenScore = union > 0 ? overlap / union : 0;
  // H2: clamp to 1 — `overlap` can exceed the shorter set's size when one imported token
  // prefix-matches several existing tokens, which previously let the score climb past 1.0 and
  // inflate the weighted merchant score beyond its intended ceiling.
  const coreTokenScore = shorterTokenCount > 0 ? Math.min(1, overlap / shorterTokenCount) : 0;

  const maxLength = Math.max(imported.length, existing.length);
  const editScore = maxLength > 0 ? 1 - levenshtein(imported, existing) / maxLength : 0;

  return Math.min(1, Math.max(tokenScore, coreTokenScore, editScore));
}

function payeeAliasKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function getPayeeAliases(payeeAliases: Map<string, string[]> | undefined, payee: string | null | undefined): string[] {
  if (!payeeAliases || !payee?.trim()) return [];

  const direct = payeeAliases.get(payee);
  if (direct) return direct;

  const key = payeeAliasKey(payee);
  for (const [name, aliases] of payeeAliases.entries()) {
    if (payeeAliasKey(name) === key) return aliases;
  }

  return [];
}

function scoreImportedPayeeMatch(
  importedPayee: string | null | undefined,
  existingPayee: string | null | undefined,
  payeeAliases?: Map<string, string[]>,
): { score: number; usedAlias: boolean } {
  const candidates = [
    importedPayee,
    ...getPayeeAliases(payeeAliases, importedPayee),
  ].filter((value): value is string => Boolean(value?.trim()));

  if (candidates.length === 0) return { score: 0, usedAlias: false };

  let bestScore = 0;
  let usedAlias = false;
  for (const candidate of candidates) {
    const score = scoreMerchantMatch(candidate, existingPayee);
    if (score > bestScore) {
      bestScore = score;
      usedAlias = candidate !== importedPayee;
    }
  }

  return { score: bestScore, usedAlias };
}

function parseDate(date: string | undefined): Date | null {
  if (!date) return null;
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const parsed = parseDate(date);
  if (!parsed) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return formatDate(parsed);
}

function dateDistanceDays(a: string | undefined, b: string | undefined): number {
  const first = parseDate(a);
  const second = parseDate(b);
  if (!first || !second) return Number.MAX_SAFE_INTEGER;
  return Math.round(Math.abs(first.getTime() - second.getTime()) / 86400000);
}

function signForType(type: ImportedStatementTransaction['type']): 1 | -1 | 0 {
  if (type === 'income') return 1;
  if (type === 'expense') return -1;
  return 0;
}

function amountDifferenceRatio(a: number, b: number): number {
  // Floor the denominator just above zero (not at 1) so sub-unit amounts compare by true
  // proportion — e.g. 0.10 vs 0.25 is a 60% gap, not the ~15% the old floor of 1 implied (L2).
  const larger = Math.max(Math.abs(a), Math.abs(b), 0.01);
  return Math.abs(Math.abs(a) - Math.abs(b)) / larger;
}

// How far a candidate's amount is from the imported amount, in the most relevant space
// (account-currency when known, else stored/base). Used to break score ties toward the closer
// amount (M6).
function matchAmountRatio(match: StatementReconciliationMatch): number {
  return match.existingAccountCurrencyAmount !== null
    ? amountDifferenceRatio(match.statementAccountCurrencyAmount, match.existingAccountCurrencyAmount)
    : amountDifferenceRatio(match.statementStoredAmount, match.existingStoredAmount);
}

function getExistingAccountCurrencyAmount(existing: DBTransaction): number | null {
  return extractAppFxAmount(existing.notes) ?? extractShortcutConvertedTargetAmount(existing.notes);
}

function isWeakPayee(value: string | null | undefined): boolean {
  return WEAK_PAYEES.has(normalizeMerchant(value));
}

function formatPlainCurrency(amount: number, currencyCode: string): string {
  return `${currencyCode} ${amount.toFixed(2)}`;
}

function formatBankRate(value: number): string {
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function buildAuditNote(match: StatementReconciliationMatch): string {
  const shortcutFx = extractShortcutFxContext(match.existingTransaction.notes);
  if (!shortcutFx || shortcutFx.sourceAmount === 0) {
    return 'Reconciled from statement; FX estimate replaced';
  }

  const bankRate = match.statementAccountCurrencyAmount / shortcutFx.sourceAmount;
  const fromText = formatPlainCurrency(shortcutFx.sourceAmount, shortcutFx.sourceCurrency);
  const toText = formatPlainCurrency(match.statementAccountCurrencyAmount, shortcutFx.targetCurrency);
  const estimatedText = formatPlainCurrency(shortcutFx.estimatedTargetAmount, shortcutFx.targetCurrency);
  const estimatedRate = shortcutFx.estimatedRate !== null
    ? `, estimated rate: ${formatBankRate(shortcutFx.estimatedRate)}`
    : '';

  return `[reconciled FX: ${fromText} -> ${toText}, bank rate: ${formatBankRate(bankRate)}, replaced estimate: ${estimatedText}${estimatedRate}]`;
}

export function findBestReconciliationMatch(
  imported: ImportedStatementTransaction,
  existingCandidates: DBTransaction[],
  account: AccountInfo,
  currencyRules: CurrencyRule[] = [],
  payeeAliases?: Map<string, string[]>,
  maxDateDistanceDays: number = 2,
): StatementReconciliationMatch | null {
  if (!imported.date || !imported.amount || imported.type === 'transfer' || imported.subtransactions?.length) {
    return null;
  }

  const rawRule = currencyRules.find(r => r.accountId === account.id);
  // Ignore a rule whose rate is unusable so we fall back to base-currency matching instead of
  // dividing/multiplying by a degenerate rate.
  const rule = rawRule && isUsableRate(rawRule.rate) ? rawRule : undefined;
  const statementAccountCurrencyAmount = Math.abs(imported.amount);
  const statementStoredAmount = rule
    ? calculateBaseAmount(statementAccountCurrencyAmount, rule.rate)
    : statementAccountCurrencyAmount;
  const importedSign = signForType(imported.type);

  const scored = existingCandidates
    .filter(existing => existing.account_id === account.id)
    .filter(existing => !existing.transfer_id)
    // Never reconcile a split parent: updating its amount without touching children breaks
    // parent = sum(children), and getAccountBalanceAsOf excludes parents so the change would
    // never reach the balance check.
    .filter(existing => !existing.is_parent)
    .map(existing => {
      const existingSign = existing.amount > 0 ? 1 : -1;
      if (importedSign !== 0 && existingSign !== importedSign) return null;

      const distance = dateDistanceDays(imported.date, existing.date);
      if (distance > maxDateDistanceDays) return null;

      const { score: merchantScore, usedAlias } = scoreImportedPayeeMatch(imported.payee, existing.payee_name, payeeAliases);
      if (merchantScore < 0.58) return null;

      const existingAccountCurrencyAmount = getExistingAccountCurrencyAmount(existing);
      const existingStoredAmount = Math.abs(existing.amount) / 100;
      const accountCurrencyRatio = existingAccountCurrencyAmount === null
        ? 1
        : amountDifferenceRatio(statementAccountCurrencyAmount, existingAccountCurrencyAmount);
      const storedRatio = amountDifferenceRatio(statementStoredAmount, existingStoredAmount);
      const fxMetadata = hasFxMetadata(existing.notes);

      const accountCurrencySignal = rule && existingAccountCurrencyAmount !== null && accountCurrencyRatio <= 0.18;
      const baseCurrencySignal = !rule && storedRatio <= 0.18;
      // M5: on a currency-rule account, a near-identical stored (base) amount is itself a strong
      // signal even when the existing transaction carries no FX-note metadata to compare against.
      const exactStoredSignal = Boolean(rule) && storedRatio <= 0.02;
      const supportingStoredSignal = storedRatio <= 0.25;
      if (!accountCurrencySignal && !baseCurrencySignal && !exactStoredSignal && !(fxMetadata && supportingStoredSignal)) {
        return null;
      }

      const score =
        merchantScore * 55
        + Math.max(0, 20 - distance * 5)
        + (accountCurrencySignal || baseCurrencySignal || exactStoredSignal ? 20 : 8)
        + (fxMetadata ? 5 : 0);

      const confidence: ReconciliationConfidence = score >= 80 ? 'high' : 'medium';
      const reasons = [
        'same account',
        `merchant ${Math.round(merchantScore * 100)}%`,
        distance === 0 ? 'same date' : `${distance}d date window`,
      ];
      if (accountCurrencySignal) reasons.push('account-currency amount changed');
      if (baseCurrencySignal) reasons.push('stored amount changed');
      if (exactStoredSignal && !accountCurrencySignal && !baseCurrencySignal) reasons.push('stored amount matches');
      if (fxMetadata) reasons.push('existing FX estimate');
      if (usedAlias) reasons.push('payee rule alias');

      const match: StatementReconciliationMatch = {
        existingTransaction: existing,
        confidence,
        score,
        merchantScore,
        existingAccountCurrencyAmount,
        statementAccountCurrencyAmount,
        existingStoredAmount,
        statementStoredAmount,
        dateDistanceDays: distance,
        reasons,
      };
      return match;
    })
    .filter((match): match is StatementReconciliationMatch => match !== null)
    // M6: break score ties toward the closer amount so an exact match outranks a near-miss.
    .sort((a, b) => b.score - a.score || matchAmountRatio(a) - matchAmountRatio(b));

  if (scored.length === 0) return null;

  const [best, second] = scored;
  if (second && Math.abs(best.score - second.score) < 3) {
    // Only ambiguous when the runner-up's amount is about as close. If `best` is clearly the
    // closer amount, it is a confident pick rather than a coin-flip (M6).
    const closenessGap = matchAmountRatio(second) - matchAmountRatio(best);
    if (closenessGap <= 0.05) {
      return { ...best, confidence: 'ambiguous' };
    }
  }

  return best;
}

export function buildReconciledTransactionUpdate(
  imported: ImportedStatementTransaction,
  match: StatementReconciliationMatch,
  currencyRule?: CurrencyRule,
): ReconciledTransactionUpdate {
  // Preserve the existing transaction's sign when the imported row has no type, so a type-less
  // statement row can never flip a matched income transaction into an expense.
  const type: 'expense' | 'income' =
    imported.type === 'income' ? 'income'
    : imported.type === 'expense' ? 'expense'
    : match.existingTransaction.amount >= 0 ? 'income' : 'expense';
  const statementAmount = Math.abs(imported.amount);
  const usableRule = currencyRule && isUsableRate(currencyRule.rate) ? currencyRule : undefined;
  const amount = usableRule ? calculateBaseAmount(statementAmount, usableRule.rate) : statementAmount;
  const preservedNote = stripStaleFxMetadata(match.existingTransaction.notes);
  const importedNote = stripStaleFxMetadata(imported.notes);
  const noteParts = [
    preservedNote,
    importedNote,
    buildAuditNote(match),
  ].filter(Boolean);
  const userNote = [...new Set(noteParts)].join(' • ');
  const notes = usableRule
    ? formatReconciledFxNote(userNote, statementAmount, usableRule)
    : userNote || undefined;

  const update: ReconciledTransactionUpdate = {
    type,
    amount,
    notes,
    date: imported.date,
  };

  if (!match.existingTransaction.category_id && imported.category) {
    update.category = imported.category;
  }

  if (isWeakPayee(match.existingTransaction.payee_name) && imported.payee) {
    update.merchant = imported.payee;
  }

  return update;
}

export function findStatementReconciliations(
  database: LedgerSource,
  importedRows: ImportedStatementTransaction[],
  accounts: AccountInfo[],
  currencyRules: CurrencyRule[] = [],
  options: FindOptions = {},
): Map<number, StatementReconciliationMatch> {
  const result = new Map<number, StatementReconciliationMatch>();
  const accountByName = new Map(accounts.map(account => [account.name, account]));
  const excludeIndices = options.excludeIndices ?? new Set<number>();
  const dateWindowDays = options.dateWindowDays ?? 2;
  const payeeAliases = options.payeeAliases;
  // M8: seed with ledger entries a prior pass already reconciled so a re-run can't claim them
  // a second time.
  const usedExistingTransactionIds = new Set<string>(options.claimedTransactionIds ?? []);

  // Pass 0 (M13): fetch each eligible row's candidate window with a single ranged query instead
  // of one synchronous query per day (was ~5 per row, ~745 for a 149-row statement).
  interface PendingRow {
    index: number;
    imported: ImportedStatementTransaction;
    account: AccountInfo;
    candidates: DBTransaction[];
  }
  const pending: PendingRow[] = [];
  for (let index = 0; index < importedRows.length; index++) {
    if (excludeIndices.has(index)) continue;

    const imported = importedRows[index];
    if (!imported.account || !imported.date) continue;

    const account = accountByName.get(imported.account);
    if (!account) continue;

    const candidates = database.findTransactionsByAccountAndDateRange(
      account.id,
      addDays(imported.date, -dateWindowDays),
      addDays(imported.date, dateWindowDays),
    );
    pending.push({ index, imported, account, candidates });
  }

  // Pass 1: compute each row's best match against all of its candidates, then order globally by
  // score (closer amount breaks ties). M8: assigning in score order stops a weak earlier row
  // from stealing the candidate that a later row matches exactly.
  const ranked = pending
    .map(row => ({
      row,
      match: findBestReconciliationMatch(row.imported, row.candidates, row.account, currencyRules, payeeAliases, dateWindowDays),
    }))
    .filter((entry): entry is { row: PendingRow; match: StatementReconciliationMatch } => entry.match !== null)
    .sort((a, b) => b.match.score - a.match.score || matchAmountRatio(a.match) - matchAmountRatio(b.match));

  // Pass 2: claim candidates in ranked order; on a conflict, recompute against the remaining
  // unclaimed candidates for that row.
  for (const { row, match } of ranked) {
    let chosen: StatementReconciliationMatch | null = match;
    if (usedExistingTransactionIds.has(chosen.existingTransaction.id)) {
      const free = row.candidates.filter(candidate => !usedExistingTransactionIds.has(candidate.id));
      chosen = findBestReconciliationMatch(row.imported, free, row.account, currencyRules, payeeAliases, dateWindowDays);
      if (!chosen) continue;
    }

    result.set(row.index, chosen);
    // M8: only a confident match claims its ledger entry. Ambiguous (near-tie) matches are
    // surfaced for manual review without locking the candidate away from other rows.
    if (chosen.confidence !== 'ambiguous') {
      usedExistingTransactionIds.add(chosen.existingTransaction.id);
    }
  }

  return result;
}

export function getDisplayCurrencyCode(match: StatementReconciliationMatch, currencyRule?: CurrencyRule): string | null {
  if (currencyRule) return currencyRule.currencyCode;
  const note = match.existingTransaction.notes ?? '';
  const codes = note.match(CURRENCY_WORD_PATTERN);
  return codes?.[0] ?? null;
}
