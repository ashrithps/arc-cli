/**
 * The last `/self` answer per client, for when arcreactor cannot be reached.
 *
 * Contract §8: offline, an operation the cached policy allows may still run —
 * reads for 24 h after the last contact, writes for 15 min — and everything
 * else fails closed. The cache is not signed: anything that can rewrite this
 * file can also read the keychain and call Actual directly (§1), so a
 * signature would protect nothing.
 */
import { agentPaths, readJsonFile, writePrivateJson } from './connection.js';
import type { SelfResponse } from './wire.js';

export const OFFLINE_READ_WINDOW_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_WRITE_WINDOW_MS = 15 * 60 * 1000;
/** A cached `/self` older than this is refreshed after the next successful authorize. */
export const SELF_REFRESH_MS = 5 * 60 * 1000;

export interface PolicyCacheFile {
  /** Local clock, ms: the last time arcreactor answered anything. */
  lastContactAt?: number;
  clients: Record<string, { self: SelfResponse; fetchedAt: number }>;
}

export function readPolicyCache(env: NodeJS.ProcessEnv = process.env): PolicyCacheFile {
  const cache = readJsonFile<PolicyCacheFile>(agentPaths(env).policyCache);
  return cache && typeof cache === 'object' ? { ...cache, clients: cache.clients ?? {} } : { clients: {} };
}

function write(cache: PolicyCacheFile, env: NodeJS.ProcessEnv): void {
  try {
    writePrivateJson(agentPaths(env).policyCache, cache);
  } catch { /* the cache is an optimisation; the gate still works online */ }
}

export function recordContact(now: number, env: NodeJS.ProcessEnv = process.env): void {
  const cache = readPolicyCache(env);
  cache.lastContactAt = now;
  write(cache, env);
}

export function cacheSelf(client: string, self: SelfResponse, now: number, env: NodeJS.ProcessEnv = process.env): void {
  const cache = readPolicyCache(env);
  cache.clients[client] = { self, fetchedAt: now };
  cache.lastContactAt = now;
  write(cache, env);
}

export function cachedSelf(client: string, env: NodeJS.ProcessEnv = process.env): { self: SelfResponse; fetchedAt: number } | null {
  return readPolicyCache(env).clients[client] ?? null;
}
