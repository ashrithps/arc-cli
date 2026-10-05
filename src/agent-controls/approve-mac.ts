/**
 * Approve a request from this Mac with Touch ID: challenge → sign → mac-decide.
 *
 * Only for calls this machine is waiting on. The phone recomputes the opHash
 * from the sealed args before it signs, so the server cannot swap the
 * operation; this Mac cannot open those args, so it checks the server's
 * opHash against the one it computed itself from the pending call instead.
 * Requests from other machines go to the phone.
 *
 * Contract §6: a Mac may approve only up to `policy.macApprovalMaxRisk`
 * (default `write`). The server enforces it; checking here first saves a
 * pointless Touch ID prompt.
 */
import type { AgentApi } from './api.js';
import { clientDisplay } from './client-identity.js';
import type { AgentConnection } from './connection.js';
import { approvalReason, buildApprovalMessage, isAvailable, MacApproverError, sign } from './mac-approver.js';
import type { PendingCall } from './pending.js';
import { cachedSelf } from './policy-cache.js';
import { RISK_ORDER } from './policy.js';
import type { ApprovalScope, MacMaxRisk } from './wire.js';

export interface ScopeChoice { scope: ApprovalScope; scopeMinutes: number }

export function parseScope(value: string | undefined): ScopeChoice {
  switch ((value ?? 'once').toLowerCase()) {
    case 'once': return { scope: 'once', scopeMinutes: 0 };
    case '15m': case '15': return { scope: 'minutes', scopeMinutes: 15 };
    case '60m': case '60': case '1h': return { scope: 'minutes', scopeMinutes: 60 };
    case 'always': return { scope: 'always', scopeMinutes: 0 };
    default: throw new Error(`Unknown scope "${value}". Use once, 15m, 60m or always.`);
  }
}

export function macMayApprove(maxRisk: MacMaxRisk, risk: PendingCall['risk']): boolean {
  if (maxRisk === 'none') return false;
  return RISK_ORDER[risk] <= RISK_ORDER[maxRisk];
}

/**
 * Resolves `approved`, or `cancelled` when the user dismissed the Touch ID
 * prompt (not an error: the request stays pending for the phone).
 */
export async function approveWithMac(
  deps: { api: AgentApi; connection: AgentConnection; env?: NodeJS.ProcessEnv },
  call: PendingCall,
  choice: ScopeChoice = { scope: 'once', scopeMinutes: 0 }
): Promise<'approved' | 'cancelled'> {
  const deviceId = deps.connection.state.macDeviceId;
  if (!deviceId) throw new Error('This Mac is not an approver yet. Run `arc approvals enroll-mac`, then approve it on your phone.');
  if (!(await isAvailable({ env: deps.env }))) {
    throw new Error('Touch ID is not available here (no arc-approver helper, or no Secure Enclave). Approve on your phone.');
  }
  const maxRisk = cachedSelf(call.client, deps.env)?.self.policy.macApprovalMaxRisk ?? 'write';
  if (!macMayApprove(maxRisk, call.risk)) {
    throw new Error(`${call.risk === 'destructive' ? 'Destructive changes' : 'This'} can only be approved on your phone.`);
  }

  const status = await deps.api.requestStatus(call.requestId);
  if (status.status !== 'pending') throw new Error(`This request is already ${status.status}.`);
  if (status.opHash !== call.opHash) {
    throw new Error('arcreactor describes a different operation than the one waiting here. Not approving.');
  }

  const challenge = await deps.api.challenge(call.requestId);
  const message = buildApprovalMessage({
    requestId: call.requestId,
    opHash: call.opHash,
    decision: 'approve',
    scope: choice.scope,
    scopeMinutes: choice.scope === 'minutes' ? choice.scopeMinutes : 0,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    deviceId,
  });
  let signature: string;
  try {
    signature = await sign(message, approvalReason(clientDisplay(call.client), call.summaryEnum), { env: deps.env });
  } catch (error) {
    if (!(error instanceof MacApproverError)) throw error;
    if (error.code === 'cancelled') return 'cancelled';
    if (error.code === 'invalidated') {
      throw new Error('Touch ID changed since this Mac was enrolled, so its key no longer works. Run `arc approvals enroll-mac` again.');
    }
    if (error.code === 'no_key') throw new Error('This Mac has no approver key. Run `arc approvals enroll-mac` first.');
    throw error;
  }
  await deps.api.macDecide(call.requestId, {
    decision: 'approve',
    scope: choice.scope,
    scopeMinutes: choice.scope === 'minutes' ? choice.scopeMinutes : 0,
    deviceId,
    nonce: challenge.nonce,
    signature,
    via: 'mac',
  });
  return 'approved';
}
