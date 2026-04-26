/**
 * Tag operations for Actual Budget.
 *
 * Tags are first-class entities in Actual (since the Jun-2025 `add_tags`
 * migration). The `tags` table stores `(id, tag, color, description, tombstone)`.
 *
 * `@actual-app/api` v25.x does NOT expose tag CRUD on the top-level public
 * surface (no `getTags()` etc.). The handlers exist as backend handlers
 * (`tags-get`, `tags-create`, `tags-update`, `tags-delete`) and are reachable
 * via `api.internal.send('<handler>', payload)` — that's the same dispatch
 * the official UI uses. We wrap that here so callers get a typed surface.
 *
 * **Tag membership on a transaction lives in `notes`** as `#tagname` text
 * (or `#"With Spaces"` for tags whose name contains whitespace) — Actual's
 * native parsing convention. The `transaction_tags` join table is a
 * server-side denormalized cache of those `#tag` tokens; we never write to
 * it directly. To tag a transaction we append `#tagname` to its notes; to
 * untag we strip it. Filtering by tag is also a notes-substring match.
 */
import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import type { Transaction } from '../types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Tag {
  id: string;
  tag: string;
  color?: string | null;
  description?: string | null;
}

// ── Notes ↔ #tag parsing ──────────────────────────────────────────────────────
//
// Mirrors `arc/utils/tagParser.ts` in the mobile app so all surfaces agree on
// the wire format.

const TAG_TOKEN = /#(?:"([^"]+)"|([\p{L}\p{N}_-]+))/gu;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const formatTag = (name: string) => (/\s/.test(name) ? `#"${name}"` : `#${name}`);

/** Extract all distinct tag names from a notes string (case-insensitive dedupe). */
export function parseTags(notes: string | null | undefined): string[] {
  if (!notes) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  TAG_TOKEN.lastIndex = 0;
  while ((m = TAG_TOKEN.exec(notes)) !== null) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Append `#name` to notes if not already present (idempotent, case-insensitive). */
export function addTagToken(notes: string, name: string): string {
  const trimmed = (notes || '').trimEnd();
  const tags = parseTags(trimmed).map(t => t.toLowerCase());
  if (tags.includes(name.toLowerCase())) return trimmed;
  return (trimmed ? trimmed + ' ' : '') + formatTag(name);
}

/** Remove `#name` (and its quoted form) from notes; collapses whitespace. */
export function removeTagToken(notes: string, name: string): string {
  if (!notes) return notes;
  const pattern = new RegExp(
    `\\s?#(?:"${escapeRegExp(name)}"|${escapeRegExp(name)}(?![\\w-]))`,
    'gi'
  );
  return notes.replace(pattern, '').replace(/\s+/g, ' ').trim();
}

/** Strip every `#tag` token from notes (used when displaying notes prose). */
export function stripTagsForDisplay(notes: string | null | undefined): string | null {
  if (notes == null) return notes ?? null;
  return notes.replace(TAG_TOKEN, '').replace(/\s+/g, ' ').trim();
}

// ── Tag CRUD via Actual API ───────────────────────────────────────────────────
//
// `actual.internal.send('<handler>', payload)` is the dispatch path the
// official UI uses for backend-only handlers. The handlers are registered
// in loot-core/src/server/tags/app.ts and accept the same arguments their
// TypeScript signatures show.

function tagHandler(client: ActualClient): (handler: string, args?: any) => Promise<any> {
  return (client.api as any).internal.send;
}

export async function listTags(client: ActualClient): Promise<Tag[]> {
  client.ensureConnected();
  const send = tagHandler(client);
  const tags = await send('tags-get');
  return (tags || []) as Tag[];
}

/** Look up a tag by name (case-insensitive). Returns undefined if not found. */
export async function findTagByName(
  client: ActualClient,
  name: string,
): Promise<Tag | undefined> {
  const tags = await listTags(client);
  const lower = name.toLowerCase();
  return tags.find(t => (t.tag || '').toLowerCase() === lower);
}

/** Resolve a name OR id to a tag id (for `--id` flags). */
export async function resolveTagId(client: ActualClient, nameOrId: string): Promise<string> {
  const tags = await listTags(client);
  const byId = tags.find(t => t.id === nameOrId);
  if (byId) return byId.id;
  const lower = nameOrId.toLowerCase();
  const byName = tags.find(t => (t.tag || '').toLowerCase() === lower);
  if (byName) return byName.id;
  throw new Error(
    `Tag not found: "${nameOrId}". Available: ${tags.map(t => t.tag).join(', ') || '(none)'}`
  );
}

export async function createTag(
  client: ActualClient,
  writer: SafeWriter,
  fields: { tag: string; color?: string; description?: string },
): Promise<Tag> {
  if (!fields.tag || !fields.tag.trim()) {
    throw new Error('Tag name is required.');
  }
  const send = tagHandler(client);
  const result = await writer.write(
    `Create tag: ${fields.tag}`,
    () => send('tags-create', {
      tag: fields.tag.trim(),
      color: fields.color,
      description: fields.description,
    }),
  );
  if (!result.success) throw new Error(result.error);
  return result.data as Tag;
}

export async function updateTag(
  client: ActualClient,
  writer: SafeWriter,
  id: string,
  fields: Partial<Pick<Tag, 'tag' | 'color' | 'description'>>,
): Promise<void> {
  const existing = await listTags(client);
  const current = existing.find(t => t.id === id);
  if (!current) throw new Error(`Tag not found: "${id}"`);
  const merged: Tag = {
    id,
    tag: fields.tag ?? current.tag,
    color: fields.color !== undefined ? fields.color : current.color,
    description: fields.description !== undefined ? fields.description : current.description,
  };
  const send = tagHandler(client);
  const result = await writer.write(
    `Update tag: ${current.tag}`,
    () => send('tags-update', merged),
  );
  if (!result.success) throw new Error(result.error);
}

export async function deleteTag(
  client: ActualClient,
  writer: SafeWriter,
  id: string,
): Promise<void> {
  const tags = await listTags(client);
  const tag = tags.find(t => t.id === id);
  if (!tag) throw new Error(`Tag not found: "${id}"`);
  const send = tagHandler(client);
  const result = await writer.write(
    `Delete tag: ${tag.tag}`,
    () => send('tags-delete', tag),
  );
  if (!result.success) throw new Error(result.error);
}

// ── Transaction × tag operations ──────────────────────────────────────────────

/**
 * Find every transaction (across all on/off-budget accounts) whose `notes`
 * contain ALL of the given tag names (case-insensitive). Mirrors the mobile
 * app's filter behavior — `parseTags()` resolves which tokens appear, so a
 * partial-string match like `#food` would NOT pick up `#foodie`.
 */
export async function listTransactionsByTags(
  client: ActualClient,
  tagNames: string[],
  startDate?: string,
  endDate?: string,
): Promise<Transaction[]> {
  client.ensureConnected();
  if (tagNames.length === 0) return [];
  const lowerTags = tagNames.map(t => t.toLowerCase());
  const accounts = await client.api.getAccounts();
  const all: Transaction[] = [];
  for (const account of accounts) {
    const txns = await (client.api as any).getTransactions(
      (account as any).id,
      startDate,
      endDate,
    );
    for (const t of txns) {
      const onTx = parseTags((t as any).notes).map(n => n.toLowerCase());
      if (lowerTags.every(needle => onTx.includes(needle))) {
        all.push(t as Transaction);
      }
    }
  }
  all.sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''));
  return all;
}

/** Append `#tag` tokens (idempotently) to a transaction's notes. */
export async function addTagsToTransaction(
  client: ActualClient,
  writer: SafeWriter,
  transactionId: string,
  tagNames: string[],
): Promise<void> {
  if (tagNames.length === 0) return;
  // Pull the current notes via a single-tx fetch — Actual's API doesn't
  // expose `getTransaction(id)` so we have to scan the relevant account.
  // The dispatcher (caller) generally already knows the account, but to
  // keep this helper standalone we fall back to scanning all accounts.
  const tx = await fetchTransaction(client, transactionId);
  if (!tx) throw new Error(`Transaction not found: ${transactionId}`);
  let notes = (tx as any).notes ?? '';
  for (const name of tagNames) notes = addTagToken(notes, name);
  // Ensure each new tag exists in the synced `tags` table so colors roam.
  await ensureTagsExist(client, writer, tagNames);
  const result = await writer.write(
    `Tag transaction: ${transactionId}`,
    () => client.api.updateTransaction(transactionId, { notes }),
  );
  if (!result.success) throw new Error(result.error);
}

/** Strip `#tag` tokens from a transaction's notes. */
export async function removeTagsFromTransaction(
  client: ActualClient,
  writer: SafeWriter,
  transactionId: string,
  tagNames: string[],
): Promise<void> {
  if (tagNames.length === 0) return;
  const tx = await fetchTransaction(client, transactionId);
  if (!tx) throw new Error(`Transaction not found: ${transactionId}`);
  let notes = (tx as any).notes ?? '';
  for (const name of tagNames) notes = removeTagToken(notes, name);
  const result = await writer.write(
    `Untag transaction: ${transactionId}`,
    () => client.api.updateTransaction(transactionId, { notes }),
  );
  if (!result.success) throw new Error(result.error);
}

/** Idempotently create any tags from `names` that don't already exist. */
export async function ensureTagsExist(
  client: ActualClient,
  writer: SafeWriter,
  names: string[],
): Promise<void> {
  if (names.length === 0) return;
  const existing = await listTags(client);
  const existingLower = new Set(existing.map(t => (t.tag || '').toLowerCase()));
  for (const name of names) {
    if (!existingLower.has(name.toLowerCase())) {
      await createTag(client, writer, { tag: name });
    }
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

async function fetchTransaction(
  client: ActualClient,
  transactionId: string,
): Promise<Transaction | undefined> {
  const accounts = await client.api.getAccounts();
  for (const account of accounts) {
    const txns = await (client.api as any).getTransactions((account as any).id);
    const found = txns.find((t: any) => t.id === transactionId);
    if (found) return found as Transaction;
  }
  return undefined;
}
