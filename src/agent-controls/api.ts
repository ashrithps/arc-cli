/**
 * Typed client for arcreactor's `/v1beta/agents` CLI routes (contract §6).
 *
 * Two failure kinds matter to the gate and they are kept apart:
 * - `AgentUnreachableError`: no answer (network, timeout, 502/503/504). The
 *   gate falls back to the cached policy, contract §8.
 * - `AgentApiError`: arcreactor answered and said no. Never a reason to fall
 *   back offline — a server that says DENIED must not be routed around by
 *   pretending it was down.
 *
 * `AGENT_REVOKED` wipes this machine's connection on the spot: the user
 * disconnected it from their phone, and nothing it holds is valid any more.
 */
import type {
  AuditCompleteBody,
  AuditPageWire,
  AuthorizeBody,
  AuthorizeResponse,
  CatalogWire,
  ChallengeResponse,
  DecideBody,
  OfflineEvent,
  PairClaimBody,
  PairClaimResponse,
  PairTokenBody,
  PairTokenResponse,
  PendingRequestSummaryWire,
  RequestStatusWire,
  SelfResponse,
} from './wire.js';

export const API_TIMEOUT_MS = 8_000;

export class AgentApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = 'AgentApiError';
  }
}

export class AgentUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentUnreachableError';
  }
}

export interface AgentApi {
  pairClaim(body: PairClaimBody): Promise<PairClaimResponse>;
  /** 200 → active (with the sealed bootstrap), 202 → still waiting for the phone. */
  pairToken(body: PairTokenBody): Promise<PairTokenResponse>;
  putCatalog(body: CatalogWire): Promise<void>;
  self(client: string): Promise<SelfResponse>;
  authorize(body: AuthorizeBody): Promise<AuthorizeResponse>;
  listPending(): Promise<{ requests: PendingRequestSummaryWire[] }>;
  requestStatus(id: string): Promise<RequestStatusWire>;
  consume(id: string, opHash: string): Promise<{ ok: true; auditId: string }>;
  cancel(id: string): Promise<void>;
  deny(id: string): Promise<void>;
  challenge(id: string): Promise<ChallengeResponse>;
  macDecide(id: string, body: DecideBody): Promise<void>;
  auditComplete(body: AuditCompleteBody): Promise<void>;
  auditBatch(events: OfflineEvent[]): Promise<{ accepted: number }>;
  activity(params: { afterSeq?: number; limit?: number; client?: string }): Promise<AuditPageWire>;
  enrollMac(body: { publicKey: string; label: string }): Promise<{ deviceId: string; status: 'pending' }>;
}

export interface HttpAgentApiOptions {
  baseUrl: string;
  connectionId?: string;
  credential?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Any answer from arcreactor, even an error: "last contact" for the offline windows. */
  onContact?: () => void;
  onRevoked?: () => void;
}

const UNREACHABLE_STATUSES = new Set([502, 503, 504]);

export function createHttpAgentApi(options: HttpAgentApiOptions): AgentApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;

  async function call<T>(method: string, route: string, body?: unknown, authed = true): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (authed) {
      if (!options.connectionId || !options.credential) {
        throw new AgentApiError('UNAUTHORIZED', 'This machine is not paired.', 401);
      }
      headers.authorization = `ArcAgent ${options.connectionId}.${options.credential}`;
    }

    let res: Response;
    try {
      res = await fetchImpl(`${options.baseUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new AgentUnreachableError(`arc could not reach arcreactor (${error instanceof Error ? error.message : String(error)})`);
    }
    if (UNREACHABLE_STATUSES.has(res.status)) {
      throw new AgentUnreachableError(`arcreactor is unavailable (HTTP ${res.status})`);
    }
    options.onContact?.();

    const text = await res.text().catch(() => '');
    let data: any = undefined;
    if (text) {
      try { data = JSON.parse(text); } catch { data = undefined; }
    }
    if (!res.ok) {
      const code: string = data?.error?.code ?? (res.status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR');
      const message: string = data?.error?.message ?? `arcreactor returned HTTP ${res.status}`;
      if (code === 'AGENT_REVOKED') options.onRevoked?.();
      throw new AgentApiError(code, message, res.status);
    }
    return { status: res.status, data: data as T };
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    async pairClaim(body) {
      return (await call<PairClaimResponse>('POST', '/pair/claim', body, false)).data;
    },
    async pairToken(body) {
      const { status, data } = await call<PairTokenResponse>('POST', '/pair/token', body, false);
      return status === 202 ? { status: 'claimed' } : data;
    },
    async putCatalog(body) {
      await call('PUT', '/catalog', body);
    },
    async self(client) {
      return (await call<SelfResponse>('GET', `/self?client=${encodeURIComponent(client)}`)).data;
    },
    async authorize(body) {
      return (await call<AuthorizeResponse>('POST', '/authorize', body)).data;
    },
    async listPending() {
      return (await call<{ requests: PendingRequestSummaryWire[] }>('GET', '/requests?status=pending')).data;
    },
    async requestStatus(requestId) {
      return (await call<RequestStatusWire>('GET', `/requests/${id(requestId)}`)).data;
    },
    async consume(requestId, opHash) {
      return (await call<{ ok: true; auditId: string }>('POST', `/requests/${id(requestId)}/consume`, { opHash })).data;
    },
    async cancel(requestId) {
      await call('POST', `/requests/${id(requestId)}/cancel`, {});
    },
    async deny(requestId) {
      await call('POST', `/requests/${id(requestId)}/deny`, {});
    },
    async challenge(requestId) {
      return (await call<ChallengeResponse>('POST', `/requests/${id(requestId)}/challenge`, {})).data;
    },
    async macDecide(requestId, body) {
      await call('POST', `/requests/${id(requestId)}/mac-decide`, body);
    },
    async auditComplete(body) {
      await call('POST', '/audit/complete', body);
    },
    async auditBatch(events) {
      return (await call<{ accepted: number }>('POST', '/audit/batch', { events })).data;
    },
    async activity({ afterSeq, limit, client }) {
      const qs = new URLSearchParams();
      if (afterSeq != null) qs.set('afterSeq', String(afterSeq));
      if (limit != null) qs.set('limit', String(limit));
      if (client) qs.set('client', client);
      const query = qs.toString();
      return (await call<AuditPageWire>('GET', `/activity${query ? `?${query}` : ''}`)).data;
    },
    async enrollMac(body) {
      return (await call<{ deviceId: string; status: 'pending' }>('POST', '/approvers/mac/enroll', body)).data;
    },
  };
}
