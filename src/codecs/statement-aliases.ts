// Ported near-verbatim from the arc app (budgetarc utils/statementAliases.ts, 1.0.50).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * Payee names learned from the statement (intel #8). When a statement row
 * matches a row the user already had, the bank's text and the user's payee
 * are a pair: "AMZN MKTP IN*2K3L9" is "Amazon". Agreed twice, the next row
 * the statement adds with that text gets the user's name instead of the
 * bank's. A payment processor's prefix alone ("PAYPAL *", "RAZORPAY",
 * "SQ *") is never a key: the merchant after it is.
 */

/** key → [payee, times agreed]. */
export type PayeeAliases = Record<string, [string, number]>;

export const MAX_ALIASES = 80;
/** Times a pair has to agree before it names a row. */
export const ALIAS_AGREE = 2;

// Payment processors and rails that front many merchants.
const PROCESSORS = /^(?:paypal|pp|payu|razorpay|rzp|sq|square|stripe|sumup|zettle|izettle|ccavenue|billdesk|cashfree|paytm|phonepe|gpay|google ?pay|apple ?pay|amazon ?pay|klarna|afterpay|clearpay|adyen|worldline|nets|mollie|upi|pos|ecom|nach|ach|neft|imps|rtgs|sepa|bpay|vps|eps|cc|dc|purchase|payment|pmt|pos purchase|card purchase|debit card|visa|mastercard|mc|rupay)\b[\s*#:/.-]*/i;

/**
 * The bank's text as a key: lower case, no reference numbers, no processor
 * prefix, the first three words. Null when nothing of the merchant is left.
 */
export function aliasKey(bankText: string): string | null {
  let s = bankText
    .toLowerCase()
    .replace(/\(ref#?[^)]*\)?/g, ' ')
    .replace(/\bref#?\s*\S+/g, ' ')
    .replace(/[a-z]*\d[\da-z]{3,}/g, ' ') // reference and card numbers
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\s&']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Peel processors and rails off the front ("upi paypal ..."), however many.
  for (let i = 0; i < 4; i++) {
    const next = s.replace(PROCESSORS, '').trim();
    if (next === s) break;
    s = next;
  }
  const words = s.split(' ').filter((w) => w.length > 1 || /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(w)).slice(0, 3);
  const key = words.join(' ');
  return key.replace(/\s/g, '').length >= 3 ? key : null;
}

/**
 * Pairs from one statement into what was learned. The same name again counts
 * once more; a different name starts over at one. The least agreed go first
 * when the list is full.
 */
export function learnAliases(prev: PayeeAliases | undefined, pairs: Array<{ bankText: string; payee: string }>): PayeeAliases | undefined {
  const next: PayeeAliases = { ...(prev ?? {}) };
  const seen = new Set<string>();
  for (const { bankText, payee } of pairs) {
    const key = aliasKey(bankText);
    const name = payee.trim().slice(0, 60);
    // One vote per key per statement: three Uber rides are one agreement.
    if (!key || !name || seen.has(key)) continue;
    seen.add(key);
    const had = next[key];
    next[key] = had && had[0] === name ? [name, had[1] + 1] : [name, 1];
  }
  const keys = Object.keys(next);
  if (keys.length > MAX_ALIASES) {
    const drop = [...keys].sort((a, b) => next[a][1] - next[b][1]).slice(0, keys.length - MAX_ALIASES);
    for (const k of drop) delete next[k];
  }
  return Object.keys(next).length ? next : undefined;
}

/** The user's name for a bank text, once agreed twice; null otherwise. */
export function aliasFor(aliases: PayeeAliases | undefined, bankText: string): string | null {
  if (!aliases) return null;
  const key = aliasKey(bankText);
  const hit = key ? aliases[key] : undefined;
  return hit && hit[1] >= ALIAS_AGREE ? hit[0] : null;
}

/** Read back from the record, dropping anything malformed. */
export function parseAliases(v: unknown): PayeeAliases | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: PayeeAliases = {};
  for (const [k, pair] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[0] && Number.isInteger(pair[1]) && (pair[1] as number) > 0) {
      out[k] = [pair[0], pair[1] as number];
    }
  }
  return Object.keys(out).length ? out : undefined;
}
