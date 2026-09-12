/**
 * Refund-marker codec — a **verbatim** port of the arc app's
 * `utils/refundMarker.ts`. Compatibility surface: the app and this CLI write
 * the same token into the same transaction notes, so do not "tidy" it.
 * tests/refund-marker.test.ts pins the exact strings the app emits.
 *
 * "Mark as refund" records that money the user already logged came back. The
 * transaction's amount is set to 0 and this token goes into its note, so the
 * row stays in its tab, struck through, instead of being deleted or offset by
 * a fake income row:
 *
 *   #refund|dir:expense|amt:24800|on:20260903
 *
 * `dir` is the direction the row had BEFORE it was zeroed — a zeroed row has
 * no sign left, so this is the only memory of which tab it belongs to.
 *
 * Because the stored amount genuinely becomes 0, every other money
 * calculation is already correct without reading this token.
 *
 * Pure module — no client, no IO.
 */

export type RefundDirection = 'expense' | 'income';

export interface RefundMarker {
  /** The direction the transaction had before it was zeroed. */
  dir: RefundDirection;
  /** Original amount in minor units (cents/paise), absolute. */
  amt: number;
  /** YYYYMMDD the refund was recorded. */
  on: string;
}

export const REFUND_TOKEN_PREFIX = '#refund|';

/**
 * Matches a whole token: `#refund|` followed by pipe-delimited key:value pairs,
 * stopping at whitespace or the start of another token. Same shape as
 * `splitTokenParser`'s TOKEN_RE, so the two never swallow each other.
 */
const TOKEN_RE = /#refund\|[^\s#]+/g;

/** SQL LIKE fragments used by Database.ts to keep zeroed rows in their tab. */
export const REFUND_SQL_LIKE = '%#refund|%';
export const refundSqlLikeForDirection = (dir: RefundDirection): string =>
  `%#refund|dir:${dir}%`;

function parseOne(raw: string): RefundMarker | null {
  if (!raw.startsWith(REFUND_TOKEN_PREFIX)) return null;
  const body = raw.slice(REFUND_TOKEN_PREFIX.length);
  const map: Record<string, string> = {};
  for (const pair of body.split('|')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx);
    if (key) map[key] = pair.slice(idx + 1);
  }

  const dir = map.dir;
  if (dir !== 'expense' && dir !== 'income') return null;

  const amt = Number.parseInt(map.amt ?? '', 10);
  if (!Number.isFinite(amt) || amt < 0) return null;

  return { dir, amt, on: map.on ?? '' };
}

/**
 * The refund marker on a note, or null. A note carrying more than one token
 * (which should not happen — `upsertRefundMarker` replaces rather than
 * appends) resolves to the last one, so a repair write always wins.
 */
export function parseRefundMarker(notes: string | null | undefined): RefundMarker | null {
  if (!notes) return null;
  const matches = notes.match(TOKEN_RE);
  if (!matches) return null;
  let found: RefundMarker | null = null;
  for (const raw of matches) {
    const token = parseOne(raw);
    if (token) found = token;
  }
  return found;
}

export function hasRefundMarker(notes: string | null | undefined): boolean {
  return parseRefundMarker(notes) !== null;
}

export function serializeRefundMarker(marker: RefundMarker): string {
  const parts = [`dir:${marker.dir}`, `amt:${Math.round(Math.abs(marker.amt))}`];
  if (marker.on) parts.push(`on:${marker.on}`);
  return REFUND_TOKEN_PREFIX + parts.join('|');
}

/**
 * Strip refund tokens from a note, leaving the human-written text with its line
 * breaks intact. Only horizontal whitespace is collapsed — collapsing `\s+`
 * would flatten the user's newlines every time a refund is written or undone.
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
 * Write the marker into a note, replacing any token already there and
 * preserving everything else the note carries (user text, `#tags`, receipt
 * markup, FX suffixes).
 */
export function upsertRefundMarker(notes: string | null | undefined, marker: RefundMarker): string {
  const humanText = stripTokensPreservingText((notes || '').trim());
  return [humanText, serializeRefundMarker(marker)].filter(Boolean).join(' ').trim();
}

/** Remove the marker, returning the note as it was before the refund. */
export function removeRefundMarker(notes: string | null | undefined): string {
  return stripTokensPreservingText((notes || '').trim());
}

/**
 * Strip refund tokens for display. Returns null for a note that was null, and
 * null for a note that held nothing but the token — matching the contract of
 * `stripTagsForDisplay` / `stripSplitTokensForDisplay`.
 */
export function stripRefundMarkerForDisplay(notes: string | null | undefined): string | null {
  if (notes == null) return null;
  const cleaned = notes.replace(TOKEN_RE, '').replace(/[^\S\n]+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/* -------------------------------------------------------------------------- */
/* Update payloads                                                             */
/* -------------------------------------------------------------------------- */

/** The transaction update that marks a row refunded. */
export interface RefundMarkPatch {
  amount: 0;
  notes: string;
}

/** The transaction update that undoes a refund. */
export interface RefundUndoPatch {
  /** Original amount in MAJOR units (dollars) — the update APIs' convention. */
  amount: number;
  /**
   * The direction to restore. Both write paths derive the stored sign from
   * `type` and fall back to the raw value when it is absent, so omitting this
   * would bring every refunded expense back as income.
   */
  type: RefundDirection;
  /**
   * The note with the marker removed — empty when the marker was all it held.
   * A plain string, never null: the editor's update channel is typed
   * `Partial<Transaction>`, and passing `undefined` there would skip the notes
   * write entirely and leave the marker behind on an un-zeroed row.
   */
  notes: string;
}

/**
 * Build the "mark as refund" update. `amountMinor` is the row's current amount
 * in minor units — signed or not; only its magnitude and sign are read.
 */
export function buildRefundMark(
  notes: string | null | undefined,
  amountMinor: number,
  on: string = refundStampToday(),
): RefundMarkPatch {
  return {
    amount: 0,
    notes: upsertRefundMarker(notes, {
      dir: amountMinor > 0 ? 'income' : 'expense',
      amt: Math.abs(amountMinor),
      on,
    }),
  };
}

/** Build the "undo refund" update, or null when the note carries no marker. */
export function buildRefundUndo(notes: string | null | undefined): RefundUndoPatch | null {
  const marker = parseRefundMarker(notes);
  if (!marker) return null;
  return { amount: marker.amt / 100, type: marker.dir, notes: removeRefundMarker(notes) };
}

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                 */
/* -------------------------------------------------------------------------- */

export type RefundIneligibility =
  /** One leg of a transfer — zeroing it desyncs the pair. */
  | 'transfer'
  /** A split parent or child — Actual requires parent = sum of children. */
  | 'split'
  /** Locked by an account reconciliation; Actual refuses the edit. */
  | 'reconciled'
  /** Nothing to refund. */
  | 'zero'
  /** Already refunded. */
  | 'already';

export type RefundEligibility = { ok: true } | { ok: false; reason: RefundIneligibility };

/**
 * The shape both callers can supply: the raw DB row (`services/db/types.ts`)
 * and the UI transaction (`types.ts`) each satisfy a subset, so the fields are
 * all optional and read defensively.
 */
export interface RefundEligibilitySource {
  amount?: number | null;
  notes?: string | null;
  transfer_id?: string | null;
  payee_name?: string | null;
  /** The UI transaction's resolved direction, when the caller has it. */
  type?: 'income' | 'expense' | 'transfer' | null;
  reconciled?: number | boolean | null;
  is_parent?: number | boolean | null;
  is_child?: number | boolean | null;
  parent_id?: string | null;
  /** camelCase aliases, so the UI transaction shape works unchanged. */
  isParent?: boolean | null;
  parentId?: string | null;
}

/** Why a row in a bulk refund did not get marked: ineligible, or the write failed. */
export type RefundSkipReason = RefundIneligibility | 'failed';

export interface RefundBatchResult {
  done: string[];
  skipped: Array<{ id: string; reason: RefundSkipReason }>;
}

/** Thrown by the write path when a row cannot be refunded. */
export class RefundIneligibleError extends Error {
  readonly reason: RefundIneligibility;

  constructor(id: string, reason: RefundIneligibility) {
    super(`Transaction ${id} cannot be refunded: ${reason}`);
    this.name = 'RefundIneligibleError';
    this.reason = reason;
  }
}

const REASON_LABELS: Record<RefundSkipReason, [singular: string, plural: string]> = {
  transfer: ['transfer', 'transfers'],
  split: ['split transaction', 'split transactions'],
  reconciled: ['reconciled transaction', 'reconciled transactions'],
  zero: ['zero-amount transaction', 'zero-amount transactions'],
  already: ['already refunded', 'already refunded'],
  failed: ['that failed to save', 'that failed to save'],
};

/** Human-readable reason for a skip report, agreeing with `count`. */
export function refundSkipLabel(reason: RefundSkipReason, count: number = 1): string {
  const [singular, plural] = REASON_LABELS[reason];
  return count === 1 ? singular : plural;
}

/**
 * "2 transfers, 1 reconciled transaction" — the tail of a bulk-refund skip
 * report, grouped so a mixed selection reads as one sentence.
 */
export function summarizeRefundSkips(
  skipped: Array<{ reason: RefundSkipReason }>,
): string {
  const counts = new Map<RefundSkipReason, number>();
  for (const { reason } of skipped) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([reason, n]) => `${n} ${refundSkipLabel(reason, n)}`)
    .join(', ');
}

export function refundEligibility(tx: RefundEligibilitySource | null | undefined): RefundEligibility {
  if (!tx) return { ok: false, reason: 'zero' };

  if (hasRefundMarker(tx.notes)) return { ok: false, reason: 'already' };
  if (tx.type === 'transfer' || tx.transfer_id || tx.payee_name?.startsWith('Transfer:')) {
    return { ok: false, reason: 'transfer' };
  }
  if (tx.is_parent || tx.is_child || tx.parent_id || tx.isParent || tx.parentId) {
    return { ok: false, reason: 'split' };
  }
  if (tx.reconciled) return { ok: false, reason: 'reconciled' };
  if (!tx.amount) return { ok: false, reason: 'zero' };

  return { ok: true };
}

/** True when this row can be marked as a refund right now. */
export function canMarkRefunded(tx: RefundEligibilitySource | null | undefined): boolean {
  return refundEligibility(tx).ok;
}

/** Today as the token's `on` stamp. Local calendar date, not UTC. */
export function refundStampToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
