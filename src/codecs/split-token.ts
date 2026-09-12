/**
 * Group-splits codec — a **verbatim** port of the arc app's
 * `utils/splitTokenParser.ts`. The app and this CLI write the same tokens into
 * the same transaction notes, so this file is a compatibility surface: do not
 * "tidy" it. tests/split-token.test.ts pins the exact strings the app emits.
 *
 * A group split marks a transaction as shared with other people. The state
 * lives in the transaction's note as a pipe-delimited token — a virtual
 * overlay that never touches account balances, registers or reconciliation:
 *
 *   #gsplit|gid:ab12cd|person:John|share:0.5|amt:45000|status:open|created:20240115
 *
 * Amounts are MINOR units (cents/paise), matching the rest of arc.
 *
 * Pure module — no client, no IO.
 */

export type SplitStatus = 'open' | 'paid';

export interface SplitToken {
  gid: string;
  person: string;
  /** Fraction owed by this person, 0..1. */
  share: number;
  /** Absolute owed amount in minor units (paise/cents). */
  amt: number;
  status: SplitStatus;
  /** YYYYMMDD */
  created: string;
  /** YYYYMMDD, present only when status === 'paid'. */
  settled?: string;
  /** Settling (repayment) transaction id, when linked. */
  stxid?: string;
}

const TOKEN_PREFIX = '#gsplit|';
// Matches a whole token: #gsplit| followed by pipe-delimited key:value pairs,
// stopping at whitespace or the start of another token.
const TOKEN_RE = /#gsplit\|[^\s#]+/g;

/** Percent-encode the few characters that would break the token grammar. */
export function encodePerson(name: string): string {
  return name
    .trim()
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/\|/g, '%7C')
    .replace(/:/g, '%3A')
    .replace(/\s+/g, '%20');
}

export function decodePerson(encoded: string): string {
  return encoded
    .replace(/%20/g, ' ')
    .replace(/%3A/g, ':')
    .replace(/%7C/g, '|')
    .replace(/%23/g, '#')
    .replace(/%25/g, '%')
    .trim();
}

/** Case-insensitive person key used to merge/compare people. */
export function personKey(name: string): string {
  return name.trim().toLowerCase();
}

function parseOne(raw: string): SplitToken | null {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const body = raw.slice(TOKEN_PREFIX.length);
  const pairs = body.split('|');
  const map: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx);
    const value = pair.slice(idx + 1);
    if (key) map[key] = value;
  }

  const gid = map.gid;
  const personRaw = map.person;
  if (!gid || !personRaw) return null;

  const share = Number(map.share);
  const amt = Number(map.amt);
  if (!Number.isFinite(share) || share < 0 || share > 1) return null;
  if (!Number.isFinite(amt) || amt < 0) return null;

  const status: SplitStatus = map.status === 'paid' ? 'paid' : 'open';

  const token: SplitToken = {
    gid,
    person: decodePerson(personRaw),
    share,
    amt: Math.round(amt),
    status,
    created: map.created || '',
  };
  if (map.settled) token.settled = map.settled;
  if (map.stxid) token.stxid = map.stxid;
  return token;
}

/**
 * Parse every `#gsplit` token out of a note string.
 *
 * Dedupes by `gid + personKey`, keeping the LAST occurrence — this is the
 * merge-on-read reconciler that keeps CRDT last-writer-wins conflicts from
 * double-counting a person on one transaction.
 */
export function parseSplitTokens(notes: string | null | undefined): SplitToken[] {
  if (!notes) return [];
  const matches = notes.match(TOKEN_RE);
  if (!matches) return [];

  const byKey = new Map<string, SplitToken>();
  for (const raw of matches) {
    const token = parseOne(raw);
    if (!token) continue;
    byKey.set(`${token.gid}:${personKey(token.person)}`, token);
  }
  return Array.from(byKey.values());
}

/** True when the note carries at least one valid split token. */
export function hasSplitTokens(notes: string | null | undefined): boolean {
  return parseSplitTokens(notes).length > 0;
}

/** Serialize a token back to its `#gsplit|...` string form. */
export function serializeSplitToken(t: SplitToken): string {
  const parts = [
    `gid:${t.gid}`,
    `person:${encodePerson(t.person)}`,
    `share:${t.share}`,
    `amt:${Math.round(t.amt)}`,
    `status:${t.status}`,
  ];
  if (t.created) parts.push(`created:${t.created}`);
  if (t.settled) parts.push(`settled:${t.settled}`);
  if (t.stxid) parts.push(`stxid:${t.stxid}`);
  return TOKEN_PREFIX + parts.join('|');
}

/**
 * Strip `#gsplit` tokens from a note, leaving the human-written text with its
 * line breaks intact. Only horizontal whitespace (spaces/tabs) is collapsed —
 * collapsing `\s+` would flatten the user's newlines into single spaces every
 * time a split is written or settled.
 */
function stripTokensPreservingText(base: string): string {
  return base
    .replace(TOKEN_RE, '')
    .replace(/[^\S\n]+/g, ' ')   // collapse runs of spaces/tabs, keep newlines
    .replace(/ *\n */g, '\n')    // tidy whitespace hugging a line break
    .replace(/\n{3,}/g, '\n\n')  // cap runs of blank lines
    .trim();
}

/**
 * Insert or replace a token (matched by gid + person) in a note string,
 * preserving the user's own text and any other people's tokens.
 */
export function upsertSplitToken(notes: string | null | undefined, token: SplitToken): string {
  const base = (notes || '').trim();
  const existing = base.match(TOKEN_RE) || [];
  const targetKey = `${token.gid}:${personKey(token.person)}`;

  // Strip every gsplit token from the text, keep the human-written remainder.
  let humanText = stripTokensPreservingText(base);

  // Rebuild the token list, replacing the matching one.
  const kept: SplitToken[] = [];
  let replaced = false;
  for (const raw of existing) {
    const t = parseOne(raw);
    if (!t) continue;
    if (`${t.gid}:${personKey(t.person)}` === targetKey) {
      kept.push(token);
      replaced = true;
    } else {
      kept.push(t);
    }
  }
  if (!replaced) kept.push(token);

  const tokenStr = kept.map(serializeSplitToken).join(' ');
  return [humanText, tokenStr].filter(Boolean).join(' ').trim();
}

/** Remove one person's token for a gid. Returns the cleaned note string. */
export function removeSplitToken(
  notes: string | null | undefined,
  gid: string,
  person: string,
): string {
  const base = (notes || '').trim();
  const existing = base.match(TOKEN_RE) || [];
  const targetKey = `${gid}:${personKey(person)}`;

  let humanText = stripTokensPreservingText(base);
  const kept: SplitToken[] = [];
  for (const raw of existing) {
    const t = parseOne(raw);
    if (!t) continue;
    if (`${t.gid}:${personKey(t.person)}` === targetKey) continue;
    kept.push(t);
  }
  const tokenStr = kept.map(serializeSplitToken).join(' ');
  return [humanText, tokenStr].filter(Boolean).join(' ').trim();
}

/** Remove every token for a gid (un-split). */
export function removeSplitGroup(notes: string | null | undefined, gid: string): string {
  const base = (notes || '').trim();
  const existing = base.match(TOKEN_RE) || [];
  let humanText = stripTokensPreservingText(base);
  const kept: SplitToken[] = [];
  for (const raw of existing) {
    const t = parseOne(raw);
    if (!t) continue;
    if (t.gid === gid) continue;
    kept.push(t);
  }
  const tokenStr = kept.map(serializeSplitToken).join(' ');
  return [humanText, tokenStr].filter(Boolean).join(' ').trim();
}

/** Strip all `#gsplit` tokens for display, leaving only human-written text. */
export function stripSplitTokensForDisplay(notes: string | null | undefined): string | null {
  if (notes == null) return null;
  const cleaned = notes.replace(TOKEN_RE, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Sum, in minor units, of what OTHERS owe on a single transaction (i.e. the
 * portion that should be removed from the user's own expense). This is the
 * amount the analytics layer subtracts from a `#gsplit` expense transaction.
 */
export function owedPortionForTransaction(notes: string | null | undefined): number {
  return parseSplitTokens(notes).reduce((sum, t) => sum + t.amt, 0);
}

/** Generate a short, stable base36 group id. */
export function generateGid(): string {
  return (
    Date.now().toString(36).slice(-4) +
    Math.random().toString(36).slice(2, 6)
  );
}
