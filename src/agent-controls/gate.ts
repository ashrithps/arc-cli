/**
 * The one choke point every agent-reachable operation passes through.
 *
 *   authorize → allow   → exec → audit/complete
 *             → deny    → AgentDeniedError
 *             → pending → persist args → wait → consume → exec → audit/complete
 *                                            → (timeout) pending result
 *   unreachable → cached policy, contract §8 (reads 24 h, writes 15 min,
 *                 destructive / ask / no cache fail closed) → spool
 *   not paired  → exec, local journal only
 *
 * MCP (`src/mcp/server.ts`), the CLI (`main()` in `src/index.ts`) and the TUI
 * all call `runGated`; `tests/gate-coverage.test.ts` checks nothing calls a
 * mutating API around it.
 */
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { PublicOperation } from '../public-surface/registry-types.js';
import { AgentApiError, AgentUnreachableError, createHttpAgentApi, type AgentApi } from './api.js';
import { computeOpHash, toBase64Url } from './canonical.js';
import type { ClientIdentity } from './client-identity.js';
import {
  agentsBaseUrl,
  isPaired,
  loadConnection,
  wipeConnection,
  type AgentConnection,
} from './connection.js';
import { wipeActualSecrets } from './credentials.js';
import { describeOperation, type OperationDescription } from './describe.js';
import { appendJournal, type JournalEntry } from './journal.js';
import { deletePending, loadPending, savePending, type PendingCall } from './pending.js';
import { evaluate } from './policy.js';
import {
  cachedSelf,
  cacheSelf,
  OFFLINE_READ_WINDOW_MS,
  OFFLINE_WRITE_WINDOW_MS,
  readPolicyCache,
  recordContact,
  SELF_REFRESH_MS,
} from './policy-cache.js';
import { sealJson } from './seal.js';
import { uploadCatalogIfChanged } from './catalog.js';
import { renewCliLicenseIfNeeded } from './license.js';
import { flushSpool, spoolEvent } from './spool.js';
import type { OfflineEvent, RequestStatusWire, Surface } from './wire.js';

// ── results and errors ──────────────────────────────────────────────────────

export type GateResult<T> =
  | { status: 'done'; result: T }
  | { status: 'pending'; requestId: string; expiresAt: number; opHash: string; reused?: boolean };

export type DenialKind =
  | 'denied' | 'policy' | 'paused' | 'expired' | 'cancelled' | 'offline' | 'revoked' | 'consumed' | 'tampered'
  | 'rate_limited';

/** How long to wait before the one retry of a rate-limited /authorize. */
export const RATE_LIMIT_RETRY_MS = 2_000;

export class AgentDeniedError extends Error {
  constructor(
    public readonly kind: DenialKind,
    message: string,
    public readonly details: { opId: string; reason?: string; requestId?: string } = { opId: '' }
  ) {
    super(message);
    this.name = 'AgentDeniedError';
  }
}

/** The MCP shape of a call still waiting for the user (contract §8). */
export function pendingApprovalPayload(pending: { requestId: string; expiresAt: number }) {
  return {
    status: 'pending_approval' as const,
    request_id: pending.requestId,
    expires_at: new Date(pending.expiresAt).toISOString(),
    message:
      'The user must approve this on their phone. Tell them it is waiting, then call ' +
      `arc_agent_request_status with request_id "${pending.requestId}" to run it once approved. ` +
      'Do not retry the original call.',
  };
}

// ── runtime ─────────────────────────────────────────────────────────────────

export interface GateRuntime {
  env: NodeJS.ProcessEnv;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** null when this machine is not paired. */
  connection: AgentConnection | null;
  /** Paired per agent.json but the credential could not be read: fail closed. */
  credentialMissing: boolean;
  api: AgentApi | null;
  hostname: string;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

export function createGateRuntime(overrides: Partial<GateRuntime> = {}): GateRuntime {
  const env = overrides.env ?? process.env;
  const now = overrides.now ?? Date.now;
  const connection = overrides.connection !== undefined ? overrides.connection : loadConnection(env);
  const credentialMissing = overrides.credentialMissing ?? (!connection && isPaired(env));
  const api = overrides.api !== undefined
    ? overrides.api
    : connection
      ? createHttpAgentApi({
          baseUrl: agentsBaseUrl(env, connection.state),
          connectionId: connection.state.connectionId,
          credential: connection.credential,
          onContact: () => recordContact(now(), env),
          onRevoked: () => revokeLocally(env),
        })
      : null;
  return {
    env,
    now,
    sleep: overrides.sleep ?? defaultSleep,
    connection,
    credentialMissing,
    api,
    hostname: overrides.hostname ?? os.hostname(),
  };
}

/**
 * The user disconnected this machine from their phone. Its agent keys and the
 * Actual credentials it was given go: going back to "unpaired" with the
 * budget still reachable would turn revocation into a way to switch
 * enforcement off.
 */
export function revokeLocally(env: NodeJS.ProcessEnv = process.env): void {
  wipeConnection(env);
  try { wipeActualSecrets(env); } catch { /* best effort */ }
}

// ── the gate ────────────────────────────────────────────────────────────────

export interface WaitOptions {
  /** How long to wait for a decision before returning `pending`. 0 = do not wait. */
  maxMs: number;
  pollMs?: number;
  /** Abort cancels the request on the server (Ctrl-C, Esc in the TUI). */
  signal?: AbortSignal;
  onPending?: (call: PendingCall, reused: boolean) => void;
  onSettled?: () => void;
}

export interface GateRequest<T> {
  op: Pick<PublicOperation, 'id' | 'group' | 'risk' | 'mode' | 'subcommand'>;
  args: Record<string, unknown>;
  surface: Surface;
  client: ClientIdentity;
  /** The budget's syncId, or "" (it is part of the opHash). */
  budget: string;
  budgetName?: string;
  /** CLI only: the command line, so `arc approvals wait` can re-run it. */
  argv?: PendingCall['argv'];
  exec: () => Promise<T>;
  wait: WaitOptions;
  runtime?: GateRuntime;
}

export async function runGated<T>(req: GateRequest<T>): Promise<GateResult<T>> {
  const rt = req.runtime ?? createGateRuntime();
  const { op } = req;

  if (op.group === 'agent') return { status: 'done', result: await req.exec() };

  const description = describeOperation(op, req.args);
  const journalBase: JournalBase = {
    opId: op.id, group: op.group, risk: op.risk, surface: req.surface, client: req.client.key,
    summary: description.summary, hostname: rt.hostname,
    detail: detailOf(op.id, req.surface, req.budgetName, description),
  };

  if (!rt.connection || !rt.api) {
    if (rt.credentialMissing) {
      appendJournal({ ...j(journalBase), decision: 'deny', outcome: 'denied', reason: 'credential_unavailable' }, rt.env);
      throw new AgentDeniedError('policy',
        'This machine is paired with arc but its agent credential could not be read (is the keychain locked?). ' +
        'Nothing runs until it can be.', { opId: op.id, reason: 'credential_unavailable' });
    }
    return runLocally(req, rt, journalBase);
  }

  const opHash = computeOpHash({ opId: op.id, budget: req.budget, surface: req.surface, args: req.args });
  const self = cachedSelf(req.client.key, rt.env)?.self;
  const sealKey = rt.connection.state.sealPublicKey ?? self?.sealPublicKey;
  const sealKeyId = rt.connection.state.sealKeyId ?? self?.sealKeyId;
  const sealedArgs = sealKey
    ? sealJson(sealKey, `args:${opHash}`, {
        v: 1, opId: op.id, surface: req.surface, budget: req.budget, budgetName: req.budgetName,
        args: req.args, summary: description.summary, fields: description.fields,
      }, { kid: sealKeyId })
    : undefined;

  const body = {
    client: req.client.key,
    clientRaw: req.client.raw,
    surface: req.surface,
    opId: op.id,
    group: op.group,
    risk: op.risk,
    opHash,
    sealedArgs,
    summaryEnum: description.summaryEnum,
  };
  let auth;
  try {
    try {
      auth = await rt.api.authorize(body);
    } catch (error) {
      // Rate limited: back off and try once more, then fail closed (below).
      if (!(error instanceof AgentApiError && error.code === 'RATE_LIMITED')) throw error;
      await rt.sleep(RATE_LIMIT_RETRY_MS);
      auth = await rt.api.authorize(body);
    }
  } catch (error) {
    if (error instanceof AgentUnreachableError) return runOffline(req, rt, journalBase, error);
    throw toDenial(error, op.id, journalBase, rt);
  }

  void afterContact(rt, req.client.key);

  if (auth.decision === 'deny') {
    appendJournal({ ...j(journalBase), decision: 'deny', outcome: 'denied', reason: auth.reason, auditId: auth.auditId,
      connectionId: rt.connection.state.connectionId }, rt.env);
    throw new AgentDeniedError(auth.reason === 'paused' ? 'paused' : 'policy', denialMessage(auth.reason, op.id),
      { opId: op.id, reason: auth.reason });
  }

  if (auth.decision === 'allow') {
    return { status: 'done', result: await execAndComplete(req, rt, journalBase, { auditId: auth.auditId, decision: 'allow' }) };
  }

  // pending
  if (!auth.requestId || !auth.expiresAt) throw new Error('arcreactor returned pending without a request id');
  const call: PendingCall = {
    requestId: auth.requestId, opId: op.id, group: op.group, risk: op.risk, opHash, surface: req.surface,
    client: req.client.key, budget: req.budget, budgetName: req.budgetName, args: req.args, argv: req.argv,
    summary: description.summary, summaryEnum: description.summaryEnum,
    createdAt: rt.now(), expiresAt: auth.expiresAt,
  };
  savePending(call, rt.env);
  if (!auth.reused) {
    appendJournal({ ...j(journalBase), decision: 'pending', outcome: 'pending', requestId: call.requestId,
      auditId: auth.auditId, connectionId: rt.connection.state.connectionId }, rt.env);
  }
  req.wait.onPending?.(call, !!auth.reused);
  try {
    const status = await waitForDecision(rt, call.requestId, req.wait);
    if (status.status === 'pending') {
      return { status: 'pending', requestId: call.requestId, expiresAt: call.expiresAt, opHash, reused: auth.reused };
    }
    return { status: 'done', result: await finishApproved(call, status, req.exec, rt, journalBase) };
  } finally {
    req.wait.onSettled?.();
  }
}

/** Finish a call left pending by an earlier run: `arc_agent_request_status`, `arc approvals wait`. */
export async function resumePending<T>(params: {
  requestId: string;
  surface?: Surface;
  exec: (call: PendingCall) => Promise<T>;
  wait: WaitOptions;
  runtime?: GateRuntime;
}): Promise<GateResult<T>> {
  const rt = params.runtime ?? createGateRuntime();
  const call = loadPending(params.requestId, rt.env);
  if (!call) {
    throw new AgentDeniedError('consumed',
      `No call waiting under request ${params.requestId} on this machine. It may already have run, or it was made elsewhere.`,
      { opId: '', requestId: params.requestId });
  }
  if (params.surface && call.surface !== params.surface) {
    throw new Error(`Request ${call.requestId} was made from the ${call.surface.toUpperCase()}; finish it there.`);
  }
  if (computeOpHash({ opId: call.opId, budget: call.budget, surface: call.surface, args: call.args }) !== call.opHash) {
    deletePending(call.requestId, rt.env);
    throw new AgentDeniedError('tampered', 'The stored call no longer matches what was sent for approval. It was discarded.',
      { opId: call.opId, requestId: call.requestId });
  }
  if (!rt.connection || !rt.api) throw new AgentDeniedError('revoked', 'This machine is no longer paired.', { opId: call.opId });

  const description = describeOperation(
    { id: call.opId, group: call.group as PublicOperation['group'], subcommand: call.opId.split('.').slice(1).join('.'),
      mode: call.risk === 'read' ? 'read' : 'write' },
    call.args
  );
  const journalBase: JournalBase = {
    opId: call.opId, group: call.group, risk: call.risk, surface: call.surface, client: call.client,
    summary: call.summary, hostname: rt.hostname,
    detail: detailOf(call.opId, call.surface, call.budgetName, description),
  };
  params.wait.onPending?.(call, true);
  try {
    let status: RequestStatusWire | { status: 'pending' };
    try {
      status = await waitForDecision(rt, call.requestId, params.wait);
    } catch (error) {
      throw toDenial(error, call.opId, journalBase, rt);
    }
    if (status.status === 'pending') {
      return { status: 'pending', requestId: call.requestId, expiresAt: call.expiresAt, opHash: call.opHash };
    }
    return { status: 'done', result: await finishApproved(call, status, () => params.exec(call), rt, journalBase) };
  } finally {
    params.wait.onSettled?.();
  }
}

// ── pieces ──────────────────────────────────────────────────────────────────

type JournalBase = Pick<JournalEntry, 'opId' | 'group' | 'risk' | 'surface' | 'client' | 'summary' | 'hostname'> & {
  /** What the phone shows for this event once it opens the sealed detail. Never journaled. */
  detail?: SealedDetail;
};

/**
 * The sealed audit detail the phone renders (budgetarc services/agents/interpret.ts):
 * `summary` is appended to its own sentence, so it carries the specifics only.
 */
export interface SealedDetail {
  v: 1;
  opId: string;
  surface: Surface;
  budgetName?: string;
  summary?: string;
  fields?: Array<{ label: string; value: string }>;
  resultCount?: number;
  error?: string;
}

function detailOf(opId: string, surface: Surface, budgetName: string | undefined, d: OperationDescription): SealedDetail {
  return { v: 1, opId, surface, budgetName, summary: d.specifics || undefined, fields: d.fields };
}

/** Journal entries take the base without the sealed detail. */
function j(base: JournalBase): Omit<JournalBase, 'detail'> {
  const { detail: _detail, ...rest } = base;
  return rest;
}

async function runLocally<T>(req: GateRequest<T>, rt: GateRuntime, journalBase: JournalBase): Promise<GateResult<T>> {
  const started = rt.now();
  try {
    const result = await req.exec();
    appendJournal({ ...j(journalBase), decision: 'local', outcome: 'ok', durationMs: rt.now() - started }, rt.env);
    return { status: 'done', result };
  } catch (error) {
    appendJournal({ ...j(journalBase), decision: 'local', outcome: 'error', durationMs: rt.now() - started,
      error: errorMessage(error) }, rt.env);
    throw error;
  }
}

async function runOffline<T>(
  req: GateRequest<T>, rt: GateRuntime, journalBase: JournalBase, cause: Error
): Promise<GateResult<T>> {
  const { op } = req;
  const now = rt.now();
  const cached = cachedSelf(req.client.key, rt.env);
  const spool = (event: Pick<OfflineEvent, 'decision' | 'result' | 'durationMs'>, error?: string) => {
    const eventId = toBase64Url(randomBytes(16));
    spoolEvent({
      opId: op.id, group: op.group, risk: op.risk, client: req.client.key, surface: req.surface, at: now,
      ...event, eventId, sealedDetail: sealDetail(rt, `detail:offline:${eventId}`, journalBase.detail, { error }),
    }, rt.env);
  };
  const deny = (reason: string, message: string): never => {
    spool({ decision: 'deny', result: 'error' });
    appendJournal({ ...j(journalBase), decision: 'deny', outcome: 'denied', reason, offline: true,
      connectionId: rt.connection?.state.connectionId }, rt.env);
    throw new AgentDeniedError('offline', message, { opId: op.id, reason });
  };

  if (!cached) {
    return deny('offline_no_cache', `${cause.message}. This agent has no cached permissions, so nothing runs until arc is reachable again.`);
  }
  // Grants carry server timestamps; shift by the skew seen when /self was cached.
  const skew = cached.self.serverTime ? cached.self.serverTime - cached.fetchedAt : 0;
  const evaluation = evaluate(
    { ...cached.self.policy, paused: cached.self.connection.paused, blocked: cached.self.blocked },
    cached.self.grants,
    now + skew,
    { opId: op.id, group: op.group, risk: op.risk }
  );
  const lastContact = readPolicyCache(rt.env).lastContactAt ?? cached.fetchedAt;
  const window = op.risk === 'read' ? OFFLINE_READ_WINDOW_MS : op.risk === 'write' ? OFFLINE_WRITE_WINDOW_MS : 0;

  if (evaluation.decision !== 'allow') {
    return deny(`offline_${evaluation.decision}`,
      `${cause.message}. ${evaluation.decision === 'ask' ? 'This needs your approval, which cannot reach your phone' : 'Your permissions refuse this'} while arc is offline.`);
  }
  if (op.risk === 'destructive') return deny('offline_destructive', `${cause.message}. Destructive changes never run offline.`);
  if (now - lastContact > window) {
    return deny('offline_stale', `${cause.message}. arc last heard from your account too long ago to allow this offline.`);
  }

  const started = rt.now();
  try {
    const result = await req.exec();
    spool({ decision: 'allow', result: 'ok', durationMs: rt.now() - started });
    appendJournal({ ...j(journalBase), decision: 'allow', outcome: 'ok', offline: true, reason: evaluation.reason,
      durationMs: rt.now() - started, connectionId: rt.connection?.state.connectionId }, rt.env);
    return { status: 'done', result };
  } catch (error) {
    spool({ decision: 'allow', result: 'error', durationMs: rt.now() - started }, errorMessage(error));
    appendJournal({ ...j(journalBase), decision: 'allow', outcome: 'error', offline: true, error: errorMessage(error),
      durationMs: rt.now() - started, connectionId: rt.connection?.state.connectionId }, rt.env);
    throw error;
  }
}

async function waitForDecision(
  rt: GateRuntime, requestId: string, wait: WaitOptions
): Promise<RequestStatusWire | { status: 'pending' }> {
  const deadline = rt.now() + Math.max(0, wait.maxMs);
  const pollMs = wait.pollMs ?? 1500;
  for (;;) {
    if (wait.signal?.aborted) {
      try { await rt.api!.cancel(requestId); } catch { /* it expires on its own */ }
      deletePending(requestId, rt.env);
      throw new AgentDeniedError('cancelled', 'Cancelled before it was approved.', { opId: '', requestId });
    }
    let status: RequestStatusWire | null = null;
    try {
      status = await rt.api!.requestStatus(requestId);
    } catch (error) {
      if (!(error instanceof AgentUnreachableError)) throw error;
      // A blip while waiting is not a decision; keep waiting until the deadline.
    }
    if (status && status.status !== 'pending') return status;
    if (rt.now() >= deadline) return { status: 'pending' };
    await rt.sleep(Math.min(pollMs, Math.max(0, deadline - rt.now())), wait.signal);
  }
}

async function finishApproved<T>(
  call: PendingCall, status: RequestStatusWire, exec: () => Promise<T>, rt: GateRuntime, journalBase: JournalBase
): Promise<T> {
  const connectionId = rt.connection?.state.connectionId;
  if (status.status !== 'approved') {
    deletePending(call.requestId, rt.env);
    const kind: DenialKind = status.status === 'expired' ? 'expired'
      : status.status === 'cancelled' ? 'cancelled'
      : status.status === 'consumed' ? 'consumed' : 'denied';
    appendJournal({ ...j(journalBase), decision: 'deny', outcome: kind === 'expired' ? 'expired' : kind === 'cancelled' ? 'cancelled' : 'denied',
      requestId: call.requestId, connectionId }, rt.env);
    throw new AgentDeniedError(kind, {
      denied: 'The user denied this request.',
      expired: 'The request expired before the user decided.',
      cancelled: 'The request was cancelled.',
      consumed: 'This approved request has already run.',
    }[kind as 'denied' | 'expired' | 'cancelled' | 'consumed'], { opId: call.opId, requestId: call.requestId });
  }
  if (status.opHash && status.opHash !== call.opHash) {
    deletePending(call.requestId, rt.env);
    throw new AgentDeniedError('tampered', 'The approval is for a different operation than the one waiting here.',
      { opId: call.opId, requestId: call.requestId });
  }

  let consumed;
  try {
    consumed = await rt.api!.consume(call.requestId, call.opHash);
  } catch (error) {
    if (error instanceof AgentApiError && (error.status === 409 || error.code === 'STATE_INVALID')) {
      deletePending(call.requestId, rt.env);
      throw new AgentDeniedError('consumed', 'This approved request has already run.', { opId: call.opId, requestId: call.requestId });
    }
    // AGENT_PAUSED: approved, but agents were paused on the phone since.
    throw toDenial(error, call.opId, journalBase, rt);
  }
  deletePending(call.requestId, rt.env);
  return execAndComplete({ exec }, rt, journalBase, {
    auditId: consumed.auditId, decision: 'allow', requestId: call.requestId, scope: status.scope,
  });
}

async function execAndComplete<T>(
  req: { exec: () => Promise<T> },
  rt: GateRuntime,
  journalBase: JournalBase,
  meta: { auditId: string; decision: 'allow'; requestId?: string; scope?: string }
): Promise<T> {
  const started = rt.now();
  const connectionId = rt.connection?.state.connectionId;
  try {
    const result = await req.exec();
    const durationMs = rt.now() - started;
    const resultCount = Array.isArray(result) ? result.length : undefined;
    appendJournal({ ...j(journalBase), decision: 'allow', outcome: 'ok', auditId: meta.auditId, requestId: meta.requestId,
      durationMs, connectionId }, rt.env);
    await complete(rt, meta.auditId, { result: 'ok', durationMs, resultCount }, journalBase.detail);
    return result;
  } catch (error) {
    const durationMs = rt.now() - started;
    appendJournal({ ...j(journalBase), decision: 'allow', outcome: 'error', auditId: meta.auditId, requestId: meta.requestId,
      durationMs, error: errorMessage(error), connectionId }, rt.env);
    await complete(rt, meta.auditId, { result: 'error', durationMs, errorCode: errorCode(error) }, journalBase.detail,
      errorMessage(error));
    throw error;
  }
}

async function complete(
  rt: GateRuntime, auditId: string,
  body: { result: 'ok' | 'error'; durationMs: number; resultCount?: number; errorCode?: string },
  detail: SealedDetail | undefined,
  error?: string
): Promise<void> {
  const sealedDetail = sealDetail(rt, `detail:${auditId}`, detail, { resultCount: body.resultCount, error });
  try {
    await rt.api!.auditComplete({ auditId, ...body, sealedDetail });
  } catch { /* the op already ran; a missed completion only loses the duration */ }
}

function sealDetail(
  rt: GateRuntime, context: string, detail: SealedDetail | undefined, extra: { resultCount?: number; error?: string } = {}
): string | undefined {
  const sealKey = rt.connection?.state.sealPublicKey;
  if (!sealKey || !detail) return undefined;
  return sealJson(sealKey, context, { ...detail, ...extra }, { kid: rt.connection?.state.sealKeyId });
}

/**
 * After any successful contact: refresh a stale policy cache, send spooled
 * offline events, upload a changed catalog, and renew a self-hosted server's
 * licence in its last week.
 */
async function afterContact(rt: GateRuntime, client: string): Promise<void> {
  try {
    const cached = cachedSelf(client, rt.env);
    if (!cached || rt.now() - cached.fetchedAt > SELF_REFRESH_MS) {
      cacheSelf(client, await rt.api!.self(client), rt.now(), rt.env);
    }
    await flushSpool(rt.api!, rt.env);
    if (rt.connection) await uploadCatalogIfChanged(rt.api!, rt.connection.state, rt.env);
  } catch { /* next time */ }
  if (rt.connection) await renewCliLicenseIfNeeded(rt.api, { env: rt.env, now: rt.now() });
}

export async function refreshSelf(client: string, runtime?: GateRuntime) {
  const rt = runtime ?? createGateRuntime();
  if (!rt.api) return null;
  const self = await rt.api.self(client);
  cacheSelf(client, self, rt.now(), rt.env);
  return self;
}

function toDenial(error: unknown, opId: string, journalBase: JournalBase, rt: GateRuntime): Error {
  if (!(error instanceof AgentApiError)) return error instanceof Error ? error : new Error(String(error));
  const kind: DenialKind | null =
    error.code === 'AGENT_REVOKED' ? 'revoked'
    : error.code === 'AGENT_PAUSED' ? 'paused'
    : error.code === 'DENIED' ? 'denied'
    : error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN' ? 'policy'
    : error.code === 'RATE_LIMITED' ? 'rate_limited'
    : null;
  if (!kind) return error;
  appendJournal({ ...j(journalBase), decision: 'deny', outcome: 'denied', reason: error.code.toLowerCase() }, rt.env);
  const message = kind === 'revoked'
    ? 'This machine was disconnected from arc on your phone. Its keys have been removed; pair it again to continue.'
    : kind === 'paused' ? 'Agents are paused on your phone.'
    : kind === 'rate_limited' ? 'Too many requests to arc right now; nothing ran. Try again in a minute.'
    : error.message;
  return new AgentDeniedError(kind, message, { opId, reason: error.code });
}

function denialMessage(reason: string, opId: string): string {
  switch (reason) {
    case 'paused': return 'Agents are paused on your phone.';
    case 'client_blocked': return 'This agent is blocked on your phone.';
    default: return `Your arc permissions do not allow ${opId} for this agent.`;
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function errorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  return (name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'Error';
}
