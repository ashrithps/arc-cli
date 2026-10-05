/**
 * Cleared / reconciled semantics, ported from the app's `utils/clearedStatus.ts`.
 *
 * Actual models settlement in two booleans on `transactions`:
 *   cleared    — the money has actually moved at the bank
 *   reconciled — the row was locked by a reconciliation and shouldn't be edited
 *
 * The app turns those into one three-state value; the CLI reads and writes the
 * same pair, so both must agree on the mapping.
 */

/**
 * Ordered by how much they constrain the row: `pending` is freely editable,
 * `cleared` is editable, `reconciled` is locked.
 */
export type ClearedState = 'pending' | 'cleared' | 'reconciled';

export const CLEARED_STATES: readonly ClearedState[] = ['pending', 'cleared', 'reconciled'];

export interface ClearedFlags {
  cleared?: boolean | null;
  reconciled?: boolean | null;
  status?: 'completed' | 'pending' | null;
}

/**
 * `reconciled` wins over `cleared`: Actual can leave a reconciled row with
 * cleared unset after a server-side edit, and the lock is the stronger fact.
 */
export function clearedStateOf(tx: ClearedFlags | null | undefined): ClearedState {
  if (!tx) return 'cleared';
  if (tx.reconciled) return 'reconciled';
  if (tx.cleared != null) return tx.cleared ? 'cleared' : 'pending';
  return tx.status === 'pending' ? 'pending' : 'cleared';
}

/** The pair of Actual columns that puts a row into `state`. */
export function flagsForClearedState(state: ClearedState): { cleared: boolean; reconciled: boolean } {
  switch (state) {
    case 'pending': return { cleared: false, reconciled: false };
    case 'cleared': return { cleared: true, reconciled: false };
    case 'reconciled': return { cleared: true, reconciled: true };
  }
}

export function parseClearedState(value: string): ClearedState {
  const v = value.trim().toLowerCase();
  if ((CLEARED_STATES as readonly string[]).includes(v)) return v as ClearedState;
  throw new Error(`Unknown status "${value}". Use one of: ${CLEARED_STATES.join(', ')}.`);
}
