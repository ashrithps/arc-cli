/**
 * Policy evaluation, contract §3. The server (`convex/lib/agentPolicy.ts`) runs
 * the identical function; the CLI only needs it when arcreactor is
 * unreachable and it falls back to the cached `/self` policy. The shared
 * vector cases in `agent-controls-vectors.json` keep the two in step.
 */
import type { Decision, GrantWire, GroupOverride, OpOverride, Preset, Risk } from './wire.js';

export const RISK_ORDER: Record<Risk, number> = { read: 0, write: 1, destructive: 2 };

export const PRESET_TABLE: Record<Preset, Record<Risk, Decision>> = {
  full: { read: 'allow', write: 'allow', destructive: 'allow' },
  standard: { read: 'allow', write: 'ask', destructive: 'ask' },
  private: { read: 'ask', write: 'ask', destructive: 'ask' },
};

export interface PolicyInput {
  preset: Preset;
  groupOverrides?: GroupOverride[];
  opOverrides?: OpOverride[];
  paused?: boolean;
  blocked?: boolean;
}

export type GrantInput = Pick<GrantWire, 'id' | 'group' | 'risk' | 'expiresAt'> & Partial<Pick<GrantWire, 'opId' | 'revokedAt'>>;

export interface OpRef { opId: string; group: string; risk: Risk }

export type PolicyReason = 'paused' | 'client_blocked' | 'op_override' | 'group_override' | 'preset' | 'grant';

export interface Evaluation {
  decision: Decision;
  reason: PolicyReason;
  grantId?: string;
}

export function evaluate(policy: PolicyInput, grants: GrantInput[], now: number, op: OpRef): Evaluation {
  if (policy.paused) return { decision: 'deny', reason: 'paused' };
  if (policy.blocked) return { decision: 'deny', reason: 'client_blocked' };

  let result: Evaluation;
  const opOverride = policy.opOverrides?.find(o => o.opId === op.opId);
  const groupOverride = policy.groupOverrides?.find(o => o.group === op.group && o.risk === op.risk);
  if (opOverride) result = { decision: opOverride.decision, reason: 'op_override' };
  else if (groupOverride) result = { decision: groupOverride.decision, reason: 'group_override' };
  else result = { decision: (PRESET_TABLE[policy.preset] ?? PRESET_TABLE.standard)[op.risk], reason: 'preset' };

  // A grant only ever turns an ask into an allow; it never upgrades a deny.
  if (result.decision !== 'ask') return result;
  const grant = grants.find(g =>
    g.revokedAt == null &&
    g.expiresAt > now &&
    (g.opId ? g.opId === op.opId : g.group === op.group && RISK_ORDER[g.risk] >= RISK_ORDER[op.risk])
  );
  return grant ? { decision: 'allow', reason: 'grant', grantId: grant.id } : result;
}
