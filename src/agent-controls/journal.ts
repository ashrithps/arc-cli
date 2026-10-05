/**
 * This machine's own record of what agents did through arc.
 *
 * The server's audit holds only enums and ids; this journal holds the
 * plaintext — "Swiggy · 4,500.00" — for what ran here, and is the only record
 * an unpaired install has. It never leaves the machine. Capped at 5000 lines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentPaths } from './connection.js';
import type { ActivityJournal } from './interpret.js';
import type { AuditRowWire, Risk, Surface } from './wire.js';

export const JOURNAL_MAX_LINES = 5000;

export type JournalOutcome = 'ok' | 'error' | 'denied' | 'pending' | 'expired' | 'cancelled';

export interface JournalEntry {
  id: string;
  at: number;
  opId: string;
  group: string;
  risk: Risk;
  surface: Surface;
  client: string;
  /** What the gate decided; `local` when the machine is not paired. */
  decision: 'allow' | 'deny' | 'pending' | 'local';
  outcome: JournalOutcome;
  /** Plain local description, e.g. "Delete transaction · 4,500.00 · Swiggy". */
  summary?: string;
  reason?: string;
  auditId?: string;
  requestId?: string;
  connectionId?: string;
  hostname?: string;
  /** Decided against the cached policy while arcreactor was unreachable. */
  offline?: boolean;
  durationMs?: number;
  error?: string;
}

export function appendJournal(
  entry: Omit<JournalEntry, 'id' | 'at'> & Partial<Pick<JournalEntry, 'id' | 'at'>>,
  env: NodeJS.ProcessEnv = process.env
): JournalEntry {
  const full: JournalEntry = { id: entry.id ?? randomUUID(), at: entry.at ?? Date.now(), ...entry } as JournalEntry;
  const file = agentPaths(env).journal;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    trim(file);
  } catch { /* the journal must never break the command it records */ }
  return full;
}

function trim(file: string): void {
  // Trim lazily: rewriting on every append would make each command O(5000).
  const size = fs.statSync(file).size;
  if (size < 512 * 1024) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length <= JOURNAL_MAX_LINES) return;
  fs.writeFileSync(file, lines.slice(-JOURNAL_MAX_LINES).join('\n') + '\n', { mode: 0o600 });
}

export interface JournalQuery {
  since?: number;
  client?: string;
  limit?: number;
}

/** Oldest first. */
export function readJournal(query: JournalQuery = {}, env: NodeJS.ProcessEnv = process.env): JournalEntry[] {
  let entries: JournalEntry[];
  try {
    entries = fs.readFileSync(agentPaths(env).journal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try { return [JSON.parse(line) as JournalEntry]; } catch { return []; }
      });
  } catch {
    return [];
  }
  if (query.since != null) entries = entries.filter(e => e.at >= query.since!);
  if (query.client) entries = entries.filter(e => e.client === query.client);
  if (query.limit != null) entries = entries.slice(-query.limit);
  return entries;
}

/**
 * The journal as the timeline's plaintext source: a server row that ran on
 * this machine gains the summary only this machine knows.
 */
export function journalLookup(entries: JournalEntry[]): ActivityJournal {
  const byAudit = new Map<string, JournalEntry>();
  const byRequest = new Map<string, JournalEntry>();
  for (const e of entries) {
    if (e.auditId) byAudit.set(e.auditId, e);
    if (e.requestId) byRequest.set(e.requestId, e);
  }
  return {
    lookup(row: AuditRowWire) {
      const hit = byAudit.get(row.id) ?? (row.requestId ? byRequest.get(row.requestId) : undefined);
      if (!hit) return undefined;
      // The verb is the row's; the journal adds only the specifics after it.
      const detail = hit.summary?.split(' · ').slice(1).join(' · ');
      return { summary: detail || undefined, hostname: hit.hostname };
    },
  };
}
