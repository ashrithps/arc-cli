/**
 * Audit hash chain verification (contract §4.10).
 *
 *   chainFields = {seq, userId, at, kind, connectionId?, client?, opId?, group?, risk?, decision?,
 *                  requestId?, source, detail?, sealedDetailSha256?, signatureSha256?}
 *   hash = hex(sha256(utf8(prevHash + "\n" + canonicalJson(chainFields))))
 *
 * The server could rewrite the history it hands us; recomputing every hash
 * here is what makes that visible. The head's `anchorHash` is the *prevHash*
 * of the oldest retained row (`anchorSeq`), so a fresh chain's head is
 * `{anchorSeq: 1, anchorHash: 64 zeros}` and a fully pruned one has
 * `anchorSeq = seq + 1, anchorHash = hash`. With a head, the rows must start at
 * genesis or at the anchor: starting anywhere later leaves the link into the
 * first row unverifiable, which is reported as a gap rather than trusted.
 * Without a head there is nothing to start from, so a mid-chain first row's
 * `prevHash` is taken as given; every link after it is checked either way.
 */
import { createHash } from 'node:crypto';
import type { AuditHeadWire, AuditRowWire } from './wire.js';
import { canonicalJson } from './canonical.js';

export const GENESIS_HASH = '0'.repeat(64);

const CHAIN_KEYS = [
  'seq', 'userId', 'at', 'kind', 'connectionId', 'client', 'opId', 'group', 'risk', 'decision',
  'requestId', 'source', 'detail', 'sealedDetailSha256', 'signatureSha256',
] as const;

export interface ChainVerdict {
  ok: boolean;
  /** Highest seq whose hash was recomputed and matched; 0 when none. */
  verifiedThrough: number;
  /** The seq of the first row that failed. */
  breakAt?: number;
  reason?: 'hash' | 'link' | 'gap' | 'genesis' | 'anchor' | 'head';
}

export function chainFieldsOf(row: Pick<AuditRowWire, (typeof CHAIN_KEYS)[number]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CHAIN_KEYS) {
    const v = (row as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    // An empty detail is not chained (the server omits it).
    if (k === 'detail' && typeof v === 'object' && Object.keys(v as object).length === 0) continue;
    out[k] = v;
  }
  return out;
}

export function chainHash(prevHash: string, fields: Record<string, unknown>): string {
  return createHash('sha256').update(`${prevHash}\n${canonicalJson(fields)}`, 'utf8').digest('hex');
}

/**
 * Verify rows (any order; sorted by seq here) against each other and, when
 * given, the head. `ok` with `verifiedThrough: 0` means there was nothing to check.
 */
export function verifyChain(entries: readonly AuditRowWire[], head?: AuditHeadWire): ChainVerdict {
  const rows = [...entries].sort((a, b) => a.seq - b.seq);
  let verifiedThrough = 0;
  const fail = (row: AuditRowWire, reason: NonNullable<ChainVerdict['reason']>): ChainVerdict => ({
    ok: false, verifiedThrough, breakAt: row.seq, reason,
  });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const prev = rows[i - 1];
    if (prev) {
      if (row.seq !== prev.seq + 1) return fail(row, 'gap');
      if (row.prevHash !== prev.hash) return fail(row, 'link');
    } else if (row.seq === 1 && row.prevHash !== GENESIS_HASH) {
      return fail(row, 'genesis');
    } else if (head && row.seq !== 1 && row.seq > head.anchorSeq) {
      return fail(row, 'gap');
    }
    if (chainHash(row.prevHash, chainFieldsOf(row)) !== row.hash) return fail(row, 'hash');
    if (head && row.seq === head.anchorSeq && row.prevHash !== head.anchorHash) return fail(row, 'anchor');
    if (head && row.seq === head.seq && row.hash !== head.hash) return fail(row, 'head');
    verifiedThrough = row.seq;
  }
  return { ok: true, verifiedThrough };
}
