/**
 * What an agent may do here, worked out from the same policy the server uses.
 *
 * Backs `arc_agent_permissions` and `arc agents whoami`. Every registry op is
 * run through `evaluate()` against the latest `/self` (cached if arcreactor
 * is unreachable), so the matrix shows overrides and grants exactly as the
 * gate will apply them, not just the preset.
 */
import { PUBLIC_OPERATIONS } from '../public-surface/operation-registry.js';
import { AgentUnreachableError } from './api.js';
import type { ClientIdentity } from './client-identity.js';
import { cachedSelf, cacheSelf } from './policy-cache.js';
import { evaluate } from './policy.js';
import type { GateRuntime } from './gate.js';
import type { Decision, GrantWire, Risk, SelfResponse } from './wire.js';

export interface PermissionsReport {
  paired: boolean;
  client: { key: string; name: string };
  message?: string;
  connection?: { id: string; label: string; paused: boolean };
  preset?: string;
  blocked?: boolean;
  /** true when this came from the cache because arcreactor was unreachable. */
  offline?: boolean;
  /** group → risk → decision, when every op of that (group, risk) agrees; "mixed" otherwise. */
  matrix?: Record<string, Partial<Record<Risk, Decision | 'mixed'>>>;
  /** ops that differ from their (group, risk) cell, by decision. */
  operations?: { allow: string[]; ask: string[]; deny: string[] };
  grants?: Array<{ scope: string; risk: Risk; expiresAt: string }>;
  pendingCount?: number;
}

export function permissionsFromSelf(
  self: SelfResponse, now: number, fetchedAt = now
): Omit<PermissionsReport, 'paired' | 'client'> {
  // Grant expiries are server time; shift by the skew seen when /self arrived.
  const skewedNow = now + (self.serverTime ? self.serverTime - fetchedAt : 0);
  const policy = { ...self.policy, paused: self.connection.paused, blocked: self.blocked };
  const decisions = PUBLIC_OPERATIONS
    .filter(op => op.group !== 'agent')
    .map(op => ({ op, decision: evaluate(policy, self.grants, skewedNow, { opId: op.id, group: op.group, risk: op.risk }).decision }));

  const matrix: PermissionsReport['matrix'] = {};
  for (const { op, decision } of decisions) {
    const row = (matrix[op.group] ??= {});
    const cell = row[op.risk];
    row[op.risk] = cell === undefined || cell === decision ? decision : 'mixed';
  }
  const operations = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
  for (const { op, decision } of decisions) {
    if (matrix[op.group]?.[op.risk] === 'mixed') operations[decision].push(op.id);
  }

  return {
    connection: { id: self.connection.id, label: self.connection.label, paused: self.connection.paused },
    preset: self.policy.preset,
    blocked: self.blocked,
    matrix,
    operations,
    grants: self.grants
      .filter((g: GrantWire) => g.revokedAt == null && g.expiresAt > skewedNow)
      .map(g => ({ scope: g.opId ?? g.group, risk: g.risk, expiresAt: new Date(g.expiresAt).toISOString() })),
    pendingCount: self.pendingCount,
  };
}

export async function describePermissions(identity: ClientIdentity, rt: GateRuntime): Promise<PermissionsReport> {
  const client = { key: identity.key, name: identity.display };
  if (!rt.api) {
    return {
      paired: false,
      client,
      message: rt.credentialMissing
        ? 'This machine is paired but its credential cannot be read (is the keychain locked?). Nothing will run until it can.'
        : 'This machine is not paired with the arc app, so every operation runs without asking. ' +
          'The user can pair it from the app: Settings → AI agents.',
    };
  }
  try {
    const self = await rt.api.self(identity.key);
    cacheSelf(identity.key, self, rt.now(), rt.env);
    return { paired: true, client, ...permissionsFromSelf(self, rt.now()) };
  } catch (error) {
    if (!(error instanceof AgentUnreachableError)) throw error;
    const cached = cachedSelf(identity.key, rt.env);
    if (!cached) return { paired: true, client, offline: true, message: `${error.message}. No cached permissions; nothing will run until arc is reachable.` };
    return { paired: true, client, offline: true, ...permissionsFromSelf(cached.self, rt.now(), cached.fetchedAt) };
  }
}
