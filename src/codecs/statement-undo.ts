// Ported from the arc app (budgetarc 1.0.50): `rowSig` verbatim from
// services/statements/budgetFilingStore.ts, `scaleSplit` verbatim from
// utils/statementFx.ts, and the partition at the top of `undoStatement`
// (services/statements/statementFiling.ts), so the preview in
// `statements show` and `statements undo` decide alike.
//
// The writes themselves live in src/operations/statements.ts. The app does
// them as raw CRDT field writes; the CLI sends the same fields through
// Actual's `transactions-batch-update` with `runTransfers: false`, which
// writes them without Actual's transfer side effects (a plain
// `updateTransaction` would delete the leg the user already had when its
// transfer is unlinked).
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

/** Scale a split's lines to a new total, keeping their proportions; the last line takes the rounding. */
export function scaleSplit(lines: number[], newTotal: number): number[] {
  const total = lines.reduce((a, b) => a + b, 0);
  if (!total) return lines;
  const out = lines.map((l) => Math.round((l * newTotal) / total));
  out[out.length - 1] += newTotal - out.reduce((a, b) => a + b, 0);
  return out;
}

/** What undoStatement does, in its order: unlock, unlink, remove, un-clear, restore. */
export interface UndoPlan {
  unlock: string[];
  unlink: NonNullable<StatementCheckpoint['linked']>;
  remove: string[];
  unclear: string[];
  restore: NonNullable<StatementCheckpoint['updated']>;
  /** Rows changed since filing: kept as they are. */
  kept: string[];
  /** Rows written by the filing that are gone since. */
  gone: string[];
}

/**
 * The partition at the top of `undoStatement`, given each written row's
 * fingerprint now (null when the row is gone). As the app: without stored
 * fingerprints nothing counts as changed.
 */
export function planUndo(stmt: StatementCheckpoint, now: Record<string, string | null> | null): UndoPlan {
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
    unlock: stmt.locked ?? [],
    unlink: (stmt.linked ?? []).filter((l) => untouched(l.id)),
    remove: (stmt.added ?? []).filter(untouched),
    unclear: stmt.cleared ?? [],
    restore: (stmt.updated ?? []).filter((u) => untouched(u.id)),
    kept: [...changed],
    gone: [...gone],
  };
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

export function undoPreview(stmt: StatementCheckpoint, now: Record<string, string | null> | null): UndoPreview {
  const p = planUndo(stmt, now);
  return {
    unlock: p.unlock.length,
    unlink: p.unlink.length,
    remove: p.remove.length,
    unclear: p.unclear.length,
    restore: p.restore.length,
    kept: p.kept.length,
    gone: p.gone.length,
  };
}

/** removeStatement's predicate: the entry undo takes off the record. */
export function isUndoneEntry(s: { end?: unknown; doc?: unknown }, end: string, doc?: string): boolean {
  return s.end === end && (!doc || !s.doc || s.doc === doc);
}
