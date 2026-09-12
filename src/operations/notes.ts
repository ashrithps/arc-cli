/**
 * The `notes` table — arc's shared side-channel, and the one write path that
 * can destroy another feature's data if used carelessly.
 *
 * Several arc features store their state inside Actual note bodies rather
 * than in custom tables, because notes ride Actual's file sync and survive a
 * device restore. The arc app and this CLI therefore write the *same* notes
 * on the *same* budget:
 *
 *   account-{accountId}                    #goal: · #debt| · #investment: · #hold:v1:
 *   {categoryId}                           #template  (bare id, no prefix)
 *   budget-{YYYY-MM}                       budget-ops log
 *   portfolio-trades-{accountId}           #trades:v1:
 *   portfolio-dividends-{accountId}        #divs:v1:
 *   portfolio-history-{accountId}-{YYYY-MM} #pfhist:v1:
 *
 * `notes-save` replaces the **entire** note body. So every write here is
 * read-modify-write, and `mutateNote` performs its read *inside* the
 * SafeWriter callback — i.e. after prepareForWrite()'s sync. Reading before
 * that would silently clobber whatever the phone wrote in between.
 *
 * Transaction notes are a different store entirely (the `transactions.notes`
 * column, written with `api.updateTransaction`) and are not handled here.
 */
import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';

export interface NoteRow {
  id: string;
  note: string;
}

// ── Note-id conventions ─────────────────────────────────────────────────────

export function accountNoteId(accountId: string): string {
  return `account-${accountId}`;
}

/** Category notes are keyed by the bare category id — no prefix. */
export function categoryNoteId(categoryId: string): string {
  return categoryId;
}

export function budgetMonthNoteId(month: string): string {
  return `budget-${month}`;
}

export function tradeNoteId(accountId: string): string {
  return `portfolio-trades-${accountId}`;
}

export function dividendNoteId(accountId: string): string {
  return `portfolio-dividends-${accountId}`;
}

export function historyNoteId(accountId: string, month: string): string {
  return `portfolio-history-${accountId}-${month}`;
}

/** Prefix matching every month shard for one account. */
export function historyNotePrefix(accountId: string): string {
  return `portfolio-history-${accountId}-`;
}

/** Recover the bare account id from an `account-`-prefixed note id. */
export function noteIdToAccountId(id: string): string {
  return id.replace(/^account-/, '');
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** Every row in the notes table. */
export async function readAllNotes(client: ActualClient): Promise<NoteRow[]> {
  client.ensureConnected();
  const res: any = await client.api.aqlQuery(
    client.api.q('notes').select(['id', 'note'])
  );
  const rows: NoteRow[] = res?.data ?? [];
  return rows.filter(r => r && typeof r.note === 'string');
}

export async function readNote(
  client: ActualClient,
  id: string
): Promise<string | null> {
  const rows = await readAllNotes(client);
  return rows.find(r => r.id === id)?.note ?? null;
}

export async function readNotesByPrefix(
  client: ActualClient,
  prefix: string
): Promise<NoteRow[]> {
  const rows = await readAllNotes(client);
  return rows.filter(r => r.id.startsWith(prefix));
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Replace a note body wholesale.
 *
 * Prefer `mutateNote`. This is only correct when the caller genuinely owns
 * the whole note — it discards anything another feature wrote.
 */
export async function writeNote(
  client: ActualClient,
  writer: SafeWriter,
  label: string,
  id: string,
  note: string
): Promise<void> {
  client.ensureConnected();
  const result = await writer.write(label, () =>
    client.internals.send('notes-save' as any, { id, note } as any)
  );
  if (!result.success) throw new Error(result.error);
}

/**
 * Read-modify-write a note safely.
 *
 * The read happens inside the write callback, so it sees the state after
 * SafeWriter has synced. `fn` receives the current body (null when the note
 * does not exist) and returns the new one; returning an unchanged value
 * still writes, which keeps the operation idempotent rather than clever.
 */
export async function mutateNote(
  client: ActualClient,
  writer: SafeWriter,
  label: string,
  id: string,
  fn: (current: string | null) => string
): Promise<string> {
  client.ensureConnected();
  let next = '';
  const result = await writer.write(label, async () => {
    const current = await readNote(client, id);
    next = fn(current);
    return client.internals.send('notes-save' as any, { id, note: next } as any);
  });
  if (!result.success) throw new Error(result.error);
  return next;
}
