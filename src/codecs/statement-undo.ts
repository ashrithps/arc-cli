// Ported from the arc app (budgetarc 1.0.50): `rowSig` verbatim from
// services/statements/budgetFilingStore.ts, and the partition at the top of
// `undoStatement` (services/statements/statementFiling.ts).
//
// Read only. The CLI does not undo a filing: undo deletes the rows a statement
// added, unlocks and un-clears rows, unlinks transfers and puts foreign
// amounts back, and the app does that through CRDT writes that bypass Actual's
// own transfer handling (CLI_PARITY.md, "Statements"). What this gives is what
// "Undo filing" on the phone would take back right now, and what it would keep
// because it was changed since.
import type { StatementCheckpoint } from './statement-checkpoints.js';

/** A short fingerprint of a row's content (FNV-1a, base36): equal when nothing was edited. */
export function rowSig(parts: unknown[]): string {
  let h = 0x811c9dc5;
  for (const ch of parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('\u0001')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The fingerprint the app stores per written row: [amount, date, payee, category_id, notes, account_id]. */
export function transactionSig(row: {
  amount: number;
  date: string;
  payee: string | null;
  category: string | null;
  notes: string | null;
  account: string;
}): string {
  return rowSig([row.amount, row.date, row.payee, row.category, row.notes, row.account]);
}

export interface UndoPreview {
  /** Rows the statement locked as reconciled: undo unlocks them. */
  unlock: number;
  /** Transfers it linked to a row you already had: undo unlinks them. */
  unlink: number;
  /** Rows it added, still as filed: undo deletes them. */
  remove: number;
  /** Rows it marked cleared: undo clears the mark. */
  unclear: number;
  /** Foreign purchases it set to what the bank charged: undo puts the old amount back. */
  restore: number;
  /** Rows changed since filing: undo keeps them as they are. */
  kept: number;
  /** Rows it wrote that are gone since. */
  gone: number;
}

/**
 * What `undoStatement` would do with this checkpoint, given each written
 * row's fingerprint now (null when the row is gone). As the app: without
 * stored fingerprints nothing counts as changed.
 */
export function undoPreview(stmt: StatementCheckpoint, now: Record<string, string | null> | null): UndoPreview {
  const changed = new Set<string>();
  const gone = new Set<string>();
  if (stmt.sigs && now) {
    for (const [id, sig] of Object.entries(stmt.sigs)) {
      if (now[id] === null || now[id] === undefined) gone.add(id);
      else if (now[id] !== sig) changed.add(id);
    }
  }
  const untouched = (id: string) => !changed.has(id) && !gone.has(id);
  return {
    unlock: stmt.locked?.length ?? 0,
    unlink: (stmt.linked ?? []).filter((l) => untouched(l.id)).length,
    remove: (stmt.added ?? []).filter(untouched).length,
    unclear: stmt.cleared?.length ?? 0,
    restore: (stmt.updated ?? []).filter((u) => untouched(u.id)).length,
    kept: changed.size,
    gone: gone.size,
  };
}
