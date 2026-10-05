/**
 * Events that ran while arcreactor was unreachable, held until it answers.
 *
 * They go up through `/audit/batch` with `offline: true` on the server side,
 * and the timeline marks them ◇ — reported by this machine, not witnessed.
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { agentPaths } from './connection.js';
import { toBase64Url } from './canonical.js';
import type { AgentApi } from './api.js';
import type { OfflineEvent } from './wire.js';

const MAX_SPOOLED = 1000;

export function spoolEvent(event: OfflineEvent, env: NodeJS.ProcessEnv = process.env): void {
  const file = agentPaths(env).spool;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch { /* best effort: the local journal still has it */ }
}

export function readSpool(env: NodeJS.ProcessEnv = process.env): OfflineEvent[] {
  try {
    return fs.readFileSync(agentPaths(env).spool, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try { return [JSON.parse(line) as OfflineEvent]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

/**
 * Send what is spooled. Returns how many were sent; leaves everything in place
 * on failure. The server dedupes on `eventId` (a duplicate still counts as
 * accepted), so a batch that succeeded is dropped whole and a retried flush is safe.
 */
export async function flushSpool(api: AgentApi, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const events = readSpool(env);
  if (events.length === 0) return 0;
  // An event spooled before eventId existed would be refused (400); give it one.
  const batch = events.slice(0, MAX_SPOOLED).map(e => (e.eventId ? e : { ...e, eventId: toBase64Url(randomBytes(16)) }));
  await api.auditBatch(batch);
  const rest = readSpool(env).slice(batch.length);
  const file = agentPaths(env).spool;
  if (rest.length === 0) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, rest.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  return batch.length;
}
