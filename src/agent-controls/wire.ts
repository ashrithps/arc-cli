/**
 * Agent Controls — wire types. Copied verbatim into arc-cli-source and budgetarc.
 * Contract: docs/specs/2026-10-05-agent-controls.md. Change here first, then copy.
 */

export type Risk = 'read' | 'write' | 'destructive';
export type Decision = 'allow' | 'ask' | 'deny';
export type Preset = 'full' | 'standard' | 'private';
export type Surface = 'mcp' | 'cli' | 'tui';
export type ApprovalScope = 'once' | 'minutes' | 'always';
export type DecidedVia = 'push' | 'app' | 'mac';
export type MacMaxRisk = 'none' | 'write' | 'destructive';
export type ConnectionStatus = 'pending' | 'claimed' | 'active' | 'denied' | 'revoked';
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed' | 'cancelled';
export type ApproverKind = 'ios-se' | 'android-strongbox' | 'android-tee' | 'mac-se';
export type AuditSource = 'server' | 'agent' | 'phone';

export type AuditKind =
  | 'connection.created' | 'connection.claimed' | 'connection.approved' | 'connection.denied'
  | 'connection.renamed' | 'connection.revoked' | 'connection.paused' | 'connection.resumed'
  | 'connection.expired'
  | 'policy.changed'
  | 'client.first_seen' | 'client.allowed' | 'client.blocked'
  | 'mismatch'
  | 'op.allowed' | 'op.denied' | 'op.completed'
  | 'request.created' | 'request.approved' | 'request.denied' | 'request.expired'
  | 'request.consumed' | 'request.cancelled'
  | 'grant.revoked'
  | 'approver.enrolled' | 'approver.revoked'
  | 'notice.sent' | 'offline.batch';

export interface ApiError { error: { code: string; message: string } }

export interface GroupOverride { group: string; risk: Risk; decision: Decision }
export interface OpOverride { opId: string; decision: Decision }

export interface PolicyWire {
  client: string; // '*' = connection default
  preset: Preset;
  groupOverrides: GroupOverride[];
  opOverrides: OpOverride[];
  macApprovalMaxRisk: MacMaxRisk;
  version: number;
  updatedAt: number;
}

export interface GrantWire {
  id: string;
  client: string;
  opId?: string;
  group: string;
  risk: Risk;
  expiresAt: number;
  createdAt: number;
  revokedAt?: number;
}

export interface ClientWire {
  client: string;
  displayName: string;
  firstSeenAt: number;
  lastSeenAt: number;
  blocked: boolean;
  allowed: boolean; // explicitly allowed despite intendedClient mismatch
  mismatch: boolean; // differs from intendedClient and not allowed
}

export interface ConnectionWire {
  id: string;
  kind: 'cli' | 'oauth';
  label: string;
  hostname?: string;
  platform?: string;
  cliVersion?: string;
  publicKey?: string; // the CLI's raw P-256 key, b64url, from `claimed` on; the phone seals the bootstrap to it
  fingerprint?: string;
  words?: string[];
  status: ConnectionStatus;
  paused: boolean;
  intendedClient?: string;
  notifyLevel: 'all' | 'destructive' | 'off';
  createdAt: number;
  approvedAt?: number;
  lastSeenAt?: number;
  clients: ClientWire[];
  policies: PolicyWire[];
  grants: GrantWire[]; // active only
  pendingCount: number;
}

export interface CatalogOp { id: string; group: string; risk: Risk; description: string }
export interface CatalogWire { cliVersion: string; ops: CatalogOp[] }

/** Phone view of a request. sealedArgs opens with the user's seal key, context "args:" + opHash. */
export interface RequestWire {
  id: string;
  connectionId: string;
  connectionLabel: string;
  client: string;
  clientDisplayName: string;
  surface: Surface;
  opId: string;
  group: string;
  risk: Risk;
  opHash: string;
  summaryEnum: string; // "<verb>:<noun>"
  sealedArgs: string;
  status: RequestStatus;
  createdAt: number;
  expiresAt: number;
  scope?: ApprovalScope;
  scopeMinutes?: number;
  decidedVia?: DecidedVia;
  decidedAt?: number;
  mismatch: boolean;
}

/** CLI view of a request (no sealed args). */
export interface RequestStatusWire {
  id: string;
  status: RequestStatus;
  opHash: string;
  expiresAt: number;
  scope?: ApprovalScope;
  scopeMinutes?: number;
  decidedVia?: DecidedVia;
}

export interface PendingRequestSummaryWire {
  id: string;
  opId: string;
  group: string;
  risk: Risk;
  summaryEnum: string;
  client: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuditDetail {
  result?: 'ok' | 'error';
  errorCode?: string;
  resultCount?: number;
  durationMs?: number;
  scope?: ApprovalScope;
  scopeMinutes?: number;
  preset?: Preset;
  fromPreset?: Preset;
  toPreset?: Preset;
  decidedVia?: DecidedVia;
  offline?: boolean;
  reason?: string;
  surface?: Surface;
  count?: number;
  // request.approved, approver.enrolled, approver.revoked: which hardware key
  approverKind?: ApproverKind;
  approverDeviceId?: string;
}

/** One audit row. These fields (minus hash/prevHash/sealedDetail/signature) are the chainFields input. */
export interface AuditRowWire {
  id: string;
  seq: number;
  userId: string;
  at: number;
  kind: AuditKind;
  connectionId?: string;
  client?: string;
  opId?: string;
  group?: string;
  risk?: Risk;
  decision?: Decision;
  requestId?: string;
  source: AuditSource;
  detail?: AuditDetail;
  sealedDetail?: string; // phone only
  sealedDetailSha256?: string;
  signature?: string; // phone only
  signatureSha256?: string;
  mismatch?: boolean;
  clientEventId?: string; // offline rows: the CLI's eventId (not chained)
  prevHash: string;
  hash: string;
}

export interface AuditHeadWire { seq: number; hash: string; anchorSeq: number; anchorHash: string }
export interface AuditPageWire { entries: AuditRowWire[]; head: AuditHeadWire }

export interface ApproverDeviceWire {
  id: string; // deviceId
  kind: ApproverKind;
  label: string;
  publicKey: string;
  status: 'pending' | 'active' | 'revoked';
  connectionId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

// ---- CLI endpoint bodies/responses ----
export interface PairClaimBody {
  pairToken: string;
  publicKey: string;
  credentialHash: string; // hex sha256 of the raw 32-byte credential
  hostname: string;
  platform: string;
  cliVersion: string;
  intendedClient?: string;
}
export interface PairClaimResponse { connectionId: string; fingerprint: string; words: string[] }
export interface PairTokenBody { connectionId: string; credential: string /* b64url raw */ }
export type PairTokenResponse =
  | { status: 'claimed' }
  | { status: 'active'; sealedBootstrap?: string; sealPublicKey?: string; sealKeyId?: string };

export interface SelfResponse {
  connection: { id: string; label: string; paused: boolean; status: ConnectionStatus; intendedClient?: string };
  policy: PolicyWire; // effective for ?client=
  blocked: boolean;
  grants: GrantWire[];
  pendingCount: number;
  sealPublicKey?: string;
  sealKeyId?: string;
  serverTime: number;
}

export interface AuthorizeBody {
  client: string;
  clientRaw?: string;
  surface: Surface;
  opId: string;
  group: string;
  risk: Risk;
  opHash: string;
  sealedArgs?: string; // omitted when no seal key is registered yet
  summaryEnum: string;
}
export interface AuthorizeResponse {
  decision: 'allow' | 'deny' | 'pending';
  reason: string;
  auditId: string;
  requestId?: string;
  expiresAt?: number;
  reused?: boolean;
}

export interface AuditCompleteBody {
  auditId: string;
  result: 'ok' | 'error';
  errorCode?: string;
  resultCount?: number;
  durationMs: number;
  sealedDetail?: string;
}

export interface OfflineEvent {
  eventId: string; // 16 random bytes, b64url, minted by the CLI; dedupe key and seal context
  opId: string; group: string; risk: Risk; decision: Decision; client: string; surface: Surface;
  at: number; result: 'ok' | 'error'; durationMs?: number;
  sealedDetail?: string; // context "detail:offline:" + eventId
}

export interface ChallengeResponse { nonce: string; expiresAt: number }

export interface DecideBody {
  decision: 'approve' | 'deny';
  scope?: ApprovalScope;
  scopeMinutes?: number;
  deviceId?: string;
  nonce?: string;
  signature?: string; // b64url DER
  via?: DecidedVia;
}

// ---- Push data (top-level APNs fields / FCM data) ----
export interface AgentApprovalPushData {
  type: 'agent_approval';
  requestId: string;
  connectionId: string;
  client: string;
}
export interface AgentNoticePushData {
  type: 'agent_notice' | 'agent_mismatch' | 'agent_usage';
  connectionId?: string; // absent on approver-set notices (a device enrolled)
  client?: string;
  seq?: number;
}
