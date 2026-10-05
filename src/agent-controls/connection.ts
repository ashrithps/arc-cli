/**
 * This machine's agent connection: who it is to arcreactor.
 *
 * The public half lives in `~/.arc-cli/agent.json` (ids, fingerprint, the
 * user's seal key). The credential and the private key live in the keychain,
 * or in the 0600 file store when the machine has none — a paired machine must
 * be able to authenticate, and refusing to persist would leave it unpaired.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getArcHome } from '../runtime-paths.js';
import { getFileKeychain, getKeychain, type Keychain } from './keychain.js';
import { SECRET_KEYS } from './credentials.js';

/** Default arcreactor site (budgetarc `EXPO_PUBLIC_ARCREACTOR_API_URL`) + the agents prefix. */
export const DEFAULT_AGENTS_URL = 'https://scrupulous-rabbit-413.convex.site/v1beta/agents';

export interface AgentConnectionState {
  connectionId: string;
  status: 'claimed' | 'active';
  fingerprint: string;
  words: string[];
  publicKey: string;
  hostname: string;
  apiBase: string;
  intendedClient?: string;
  label?: string;
  claimedAt: number;
  pairedAt?: number;
  /** The user's seal key: request args and audit detail are sealed to it. */
  sealPublicKey?: string;
  sealKeyId?: string;
  /** Set by `arc approvals enroll-mac`. */
  macDeviceId?: string;
  /** The CLI version whose catalog was last uploaded. */
  catalogVersion?: string;
}

export interface AgentConnection {
  state: AgentConnectionState;
  credential: string;
}

export function agentPaths(env: NodeJS.ProcessEnv = process.env) {
  const home = getArcHome(env);
  return {
    home,
    state: path.join(home, 'agent.json'),
    policyCache: path.join(home, 'agent-policy.json'),
    spool: path.join(home, 'agent-spool.jsonl'),
    journal: path.join(home, 'activity.jsonl'),
    pendingDir: path.join(home, 'pending'),
    auditCache: path.join(home, 'agent-audit.json'),
    bannerStamp: path.join(home, '.unpaired-banner'),
  };
}

/**
 * Where arcreactor's agent routes are. `ARC_AGENTS_URL` chooses it only at
 * pairing; after that the URL recorded in agent.json wins, or an agent could
 * point a paired CLI at a server of its own that answers "allow".
 */
export function agentsBaseUrl(env: NodeJS.ProcessEnv = process.env, state?: AgentConnectionState | null): string {
  return (state?.apiBase || env.ARC_AGENTS_URL || DEFAULT_AGENTS_URL).replace(/\/+$/, '');
}

/** Agent secrets must persist, so the file store stands in for a missing OS keychain. */
export function agentSecretStore(env: NodeJS.ProcessEnv = process.env): Keychain {
  return getKeychain(env) ?? getFileKeychain(env);
}

export function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readConnectionState(env: NodeJS.ProcessEnv = process.env): AgentConnectionState | null {
  return readJsonFile<AgentConnectionState>(agentPaths(env).state);
}

export function saveConnectionState(state: AgentConnectionState, env: NodeJS.ProcessEnv = process.env): void {
  writePrivateJson(agentPaths(env).state, state);
}

export function updateConnectionState(
  patch: Partial<AgentConnectionState>,
  env: NodeJS.ProcessEnv = process.env
): AgentConnectionState | null {
  const current = readConnectionState(env);
  if (!current) return null;
  const next = { ...current, ...patch };
  saveConnectionState(next, env);
  return next;
}

/** The active connection, or null when this machine is not paired (or pairing never finished). */
export function loadConnection(env: NodeJS.ProcessEnv = process.env): AgentConnection | null {
  const state = readConnectionState(env);
  if (!state || state.status !== 'active') return null;
  let credential: string | null = null;
  try {
    credential = agentSecretStore(env).get(SECRET_KEYS.agentCredential);
  } catch {
    credential = null;
  }
  if (!credential) return null;
  return { state, credential };
}

/**
 * Is this machine paired, as far as enforcement is concerned?
 *
 * Deliberately true when agent.json says active even if the credential cannot
 * be read (a locked keychain over SSH): that must fail closed, not quietly
 * fall back to the unpaired, unenforced path.
 */
export function isPaired(env: NodeJS.ProcessEnv = process.env): boolean {
  return readConnectionState(env)?.status === 'active';
}

/** Forget this machine's connection: keys, cached policy, pending requests. The journal stays. */
export function wipeConnection(env: NodeJS.ProcessEnv = process.env): void {
  const paths = agentPaths(env);
  const store = agentSecretStore(env);
  for (const key of [SECRET_KEYS.agentCredential, SECRET_KEYS.agentPrivateKey]) {
    try { store.delete(key); } catch { /* best effort */ }
  }
  for (const file of [paths.state, paths.policyCache, paths.auditCache, paths.spool]) fs.rmSync(file, { force: true });
  fs.rmSync(paths.pendingDir, { recursive: true, force: true });
}
