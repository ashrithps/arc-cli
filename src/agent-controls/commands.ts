/**
 * The Agent Controls CLI: `arc auth pair|status|unpair`, `arc approvals …`,
 * `arc activity`, `arc agents …`, `arc agent …`, and the gate wrapper every
 * data command runs through.
 *
 * Nothing here edits policy. The phone owns it; a CLI that could loosen its
 * own permissions would be a permission an agent could grant itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import chalk from 'chalk';
import { parseInstallPayload } from '../payload.js';
import { saveBootstrapPayload } from '../credential-store.js';
import { loadRuntimeConfig } from '../config-store.js';
import { getLocalVersion } from '../version.js';
import { AgentApiError, AgentUnreachableError, createHttpAgentApi } from './api.js';
import { approveWithMac, parseScope } from './approve-mac.js';
import { buildCatalog } from './catalog.js';
import { fingerprintOf, sha256Hex, toBase64Url } from './canonical.js';
import { argsFromArgv, type ParsedCommand } from './cli-operation.js';
import { isInteractive, nonTtyWaitMs, ttyWait } from './cli-wait.js';
import { clientDisplay, detectClientFromEnv, parseIntendedClient } from './client-identity.js';
import {
  agentPaths,
  agentSecretStore,
  agentsBaseUrl,
  readConnectionState,
  saveConnectionState,
  updateConnectionState,
  wipeConnection,
  type AgentConnectionState,
} from './connection.js';
import { migrateSecretsToKeychain, SECRET_KEYS, wipeActualSecrets } from './credentials.js';
import { getKeychain } from './keychain.js';
import { FINGERPRINT_WORDS } from './fingerprint-words.js';
import { inlineStatementFile } from '../operations/reconciliation.js';
import {
  AgentDeniedError,
  createGateRuntime,
  pendingApprovalPayload,
  refreshSelf,
  resumePending,
  runGated,
  type GateResult,
  type GateRuntime,
} from './gate.js';
import { journalLookup, readJournal, type JournalEntry } from './journal.js';
import * as mac from './mac-approver.js';
import { listPending, loadPending, type PendingCall } from './pending.js';
import { describePermissions } from './permissions.js';
import { cachedSelf, cacheSelf, readPolicyCache } from './policy-cache.js';
import { verifyChain, type ChainVerdict } from './chain.js';
import {
  defaultRenderOptions,
  followActivity,
  renderActivityFrom,
  renderPending,
  renderWhoami,
} from './render-timeline.js';
import { generateKeyPair, openJson } from './seal.js';
import type { PublicOperation } from '../public-surface/registry-types.js';
import type { AuditHeadWire, AuditRowWire } from './wire.js';

export const EXIT_PENDING = 75;
export const EXIT_DENIED = 77;

const BRASS = chalk.hex('#C9A44C');
const VERMILION = chalk.hex('#E5533D');

type Flags = Record<string, string>;
const isJson = (flags: Flags) => flags.json === 'true';
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

// ── unpaired banner ─────────────────────────────────────────────────────────

/**
 * One line on stderr, at most once a day, on an install with no enforcement.
 *
 * Off unless ARC_PAIR_BANNER=1: it points at **Connect a machine**, which only
 * the next arc app release has. Until that ships, an unpaired install is the
 * normal install and must print nothing new. ARC_NO_PAIR_BANNER still wins.
 */
export function maybeUnpairedBanner(env: NodeJS.ProcessEnv = process.env, now = Date.now()): void {
  if (env.ARC_PAIR_BANNER !== '1') return;
  if (readConnectionState(env)?.status === 'active') return;
  if (env.ARC_NO_PAIR_BANNER) return;
  const stamp = agentPaths(env).bannerStamp;
  const today = new Date(now).toISOString().slice(0, 10);
  try {
    if (fs.readFileSync(stamp, 'utf8').trim() === today) return;
  } catch { /* first time */ }
  process.stderr.write(chalk.dim(
    'arc: tip — the arc app can approve agent changes on your phone (Settings → AI agents → Connect a machine). Hide this: ARC_NO_PAIR_BANNER=1\n'
  ));
  try {
    fs.mkdirSync(agentPaths(env).home, { recursive: true });
    fs.writeFileSync(stamp, today);
  } catch { /* best effort */ }
}

// ── budget for the opHash ───────────────────────────────────────────────────

/** The syncId a command will run against. `--budget` may be a name; map it through the saved catalog. */
export function resolveCliBudget(flags: Flags, env: NodeJS.ProcessEnv = process.env): string {
  const requested = flags.budget || env.ACTUAL_BUDGET_SYNC_ID;
  let config: ReturnType<typeof loadRuntimeConfig> | null = null;
  try {
    config = loadRuntimeConfig(env);
  } catch {
    config = null;
  }
  if (!requested) return config?.defaultSyncId ?? '';
  const budgets = config?.budgets ?? {};
  if (budgets[requested]) return requested;
  const byName = Object.entries(budgets).find(([, b]) => b.budgetName === requested);
  return byName ? byName[0] : requested;
}

// ── gate wrapper for CLI data commands ──────────────────────────────────────

/**
 * `arc reconcile … --file x.csv` → `--lines '<json>'`, in place, before the
 * gate hashes the args. The approval (and a later `arc approvals wait`) then
 * covers the statement's contents, and the run uses exactly those lines.
 */
export function inlineStatementFlags(parsed: ParsedCommand): void {
  const f = parsed.flags;
  if (!f.file || f.file === 'true') return;
  const args = inlineStatementFile({
    file: f.file,
    date_format: f['date-format'] ?? f.date_format,
    invert: f.invert,
    opening_balance: f['opening-balance'] != null ? Number(f['opening-balance']) : undefined,
    closing_balance: f['closing-balance'] != null ? Number(f['closing-balance']) : undefined,
  } as Record<string, unknown>);
  for (const k of ['file', 'date-format', 'date_format', 'invert']) delete f[k];
  f.lines = JSON.stringify(args.lines);
  if (args.opening_balance != null) f['opening-balance'] = String(args.opening_balance);
  if (args.closing_balance != null) f['closing-balance'] = String(args.closing_balance);
}

/**
 * Run one CLI data command through the gate. Returns the exit code the
 * process should end with (0, 75 pending, 77 denied); command errors throw.
 */
export async function runCliGated(
  parsed: ParsedCommand,
  op: PublicOperation,
  exec: () => Promise<void>,
  runtime: GateRuntime = createGateRuntime()
): Promise<number> {
  if (!runtime.connection && !runtime.credentialMissing) maybeUnpairedBanner(runtime.env, runtime.now());
  if (op.group === 'reconcile') inlineStatementFlags(parsed);
  const interactive = isInteractive();
  const wait = interactive
    ? ttyWait({ touchId: touchIdFor(runtime) })
    : { maxMs: nonTtyWaitMs(runtime.env) };

  let outcome: GateResult<void>;
  try {
    outcome = await runGated({
      op,
      args: argsFromArgv(op, parsed),
      surface: 'cli',
      client: detectClientFromEnv(runtime.env),
      budget: resolveCliBudget(parsed.flags, runtime.env),
      argv: parsed,
      exec,
      wait,
      runtime,
    });
  } catch (error) {
    if (error instanceof AgentDeniedError) return reportDenied(error, interactive);
    throw error;
  }
  if (outcome.status === 'pending') return reportPending(outcome, interactive);
  return 0;
}

function touchIdFor(runtime: GateRuntime) {
  const connection = runtime.connection;
  if (!connection?.state.macDeviceId || !runtime.api || process.platform !== 'darwin') return undefined;
  const api = runtime.api;
  return (call: PendingCall) => approveWithMac({ api, connection, env: runtime.env }, call);
}

function reportDenied(error: AgentDeniedError, interactive: boolean): number {
  if (interactive) {
    process.stderr.write(`${VERMILION('✗')} ${error.message}\n`);
  } else {
    print({ status: 'denied', reason: error.kind, message: error.message, request_id: error.details.requestId });
  }
  return EXIT_DENIED;
}

function reportPending(pending: { requestId: string; expiresAt: number }, interactive: boolean): number {
  const payload = {
    ...pendingApprovalPayload(pending),
    message: `Waiting for approval on the user's phone. Run \`arc approvals wait ${pending.requestId}\` to finish it once approved.`,
  };
  if (interactive) process.stderr.write(`${BRASS('◆')} ${payload.message}\n`);
  else print(payload);
  return EXIT_PENDING;
}

// ── arc auth pair | status | unpair ─────────────────────────────────────────

const PAIR_POLL_MS = 2_000;
const PAIR_TIMEOUT_MS = 10 * 60 * 1000;

export async function handleAuthPair(
  positional: string[],
  flags: Flags,
  options: { env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void>; fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<void> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const token = positional[0] || flags.token;
  if (!token || token === 'true') throw new Error('Usage: arc auth pair <token> [--agent <key>] [--label <name>]');

  const existing = readConnectionState(env);
  if (existing?.status === 'active') {
    throw new Error(`This machine is already paired (${existing.label ?? existing.connectionId}). Run \`arc auth unpair\` first.`);
  }
  const intended = parseIntendedClient(flags.agent);
  const baseUrl = agentsBaseUrl(env);
  const keys = generateKeyPair();
  const credential = randomBytes(32);
  const publicKey = toBase64Url(keys.publicKey);
  const fingerprint = fingerprintOf(keys.publicKey);

  const anon = createHttpAgentApi({ baseUrl, fetchImpl: options.fetchImpl });
  const claim = await anon.pairClaim({
    pairToken: token,
    publicKey,
    credentialHash: sha256Hex(credential),
    hostname: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    cliVersion: buildCatalog().cliVersion,
    intendedClient: intended?.key,
  });
  if (claim.fingerprint !== fingerprint) {
    throw new Error('arcreactor answered with a fingerprint for a different key. Not pairing.');
  }

  const store = agentSecretStore(env);
  store.set(SECRET_KEYS.agentPrivateKey, toBase64Url(keys.secret));
  store.set(SECRET_KEYS.agentCredential, toBase64Url(credential));
  const state: AgentConnectionState = {
    connectionId: claim.connectionId,
    status: 'claimed',
    fingerprint,
    words: claim.words?.length ? claim.words : wordsFor(keys.publicKey),
    publicKey,
    hostname: os.hostname(),
    apiBase: baseUrl,
    intendedClient: intended?.key,
    label: flags.label && flags.label !== 'true' ? flags.label : undefined,
    claimedAt: now(),
  };
  saveConnectionState(state, env);

  console.log('');
  console.log(`  ${chalk.bold('Check these words match the ones on your phone:')}`);
  console.log('');
  console.log(`      ${BRASS(state.words.join('  ·  '))}`);
  console.log(`      ${chalk.dim(fingerprint)}`);
  console.log('');
  console.log(chalk.dim('  Then approve with Face ID. Waiting…'));

  const deadline = now() + PAIR_TIMEOUT_MS;
  let result;
  for (;;) {
    try {
      result = await anon.pairToken({ connectionId: claim.connectionId, credential: toBase64Url(credential) });
    } catch (error) {
      if (error instanceof AgentUnreachableError) {
        result = { status: 'claimed' as const };
      } else {
        wipeConnection(env);
        const code = error instanceof AgentApiError ? error.code : '';
        if (code === 'DENIED') throw new Error('Pairing was turned down on your phone.');
        if (code === 'PAIR_EXPIRED') throw new Error('The pairing code expired. Start again from the arc app.');
        if (code === 'PAIR_USED') throw new Error('That pairing code was already used. Start again from the arc app.');
        throw error;
      }
    }
    if (result.status === 'active') break;
    if (now() >= deadline) {
      wipeConnection(env);
      throw new Error('Timed out waiting for approval on your phone. Start again from the arc app.');
    }
    await sleep(PAIR_POLL_MS);
  }

  if (result.sealedBootstrap) {
    const payload = openJson<Record<string, unknown>>(keys.secret, `bootstrap:${claim.connectionId}`, result.sealedBootstrap);
    saveBootstrapPayload(parseInstallPayload(payload as any), env);
  }
  const migration = migrateSecretsToKeychain(env);
  const active = updateConnectionState({
    status: 'active',
    pairedAt: now(),
    sealPublicKey: result.sealPublicKey,
    sealKeyId: result.sealKeyId,
  }, env)!;

  const runtime = createGateRuntime({ env, now, api: createHttpAgentApi({
    baseUrl, connectionId: claim.connectionId, credential: toBase64Url(credential), fetchImpl: options.fetchImpl,
  }) });
  try {
    const catalog = buildCatalog();
    await runtime.api!.putCatalog(catalog);
    updateConnectionState({ catalogVersion: catalog.cliVersion }, env);
    const client = intended ?? detectClientFromEnv(env);
    cacheSelf(client.key, await runtime.api!.self(client.key), now(), env);
  } catch { /* the gate retries both on first use */ }

  console.log('');
  console.log(`  ${chalk.green('✓')} Paired ${chalk.bold(active.label ?? os.hostname())}${intended ? ` for ${intended.display}` : ''}.`);
  if (result.sealedBootstrap) console.log(chalk.dim('    Budget access arrived sealed to this machine.'));
  if (migration.status === 'migrated') console.log(chalk.dim(`    Secrets are in the ${migration.backend === 'file' ? 'protected secrets file' : 'keychain'}.`));
  console.log(chalk.dim('    Agents now ask before changing anything. See `arc agents whoami`.'));
}

function wordsFor(publicKeyRaw: Uint8Array): string[] {
  const digest = Buffer.from(sha256Hex(publicKeyRaw), 'hex');
  return [...digest.subarray(0, 4)].map(b => FINGERPRINT_WORDS[b]);
}

export async function handleAuthStatus(flags: Flags, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const state = readConnectionState(env);
  const kc = getKeychain(env);
  let secretsIn = 'config file';
  try {
    const raw = JSON.parse(fs.readFileSync(agentPaths(env).home + '/config.json', 'utf8'));
    if (raw.secretsIn === 'keychain') secretsIn = kc?.name === 'file' ? 'secrets file (0600)' : kc ? 'keychain' : 'keychain (unreachable)';
  } catch { secretsIn = 'not configured'; }
  const cache = readPolicyCache(env);
  const report: Record<string, unknown> = {
    paired: state?.status === 'active',
    status: state?.status ?? 'unpaired',
    connectionId: state?.connectionId,
    label: state?.label,
    hostname: state?.hostname,
    fingerprint: state?.fingerprint,
    words: state?.words,
    intendedClient: state?.intendedClient,
    macApprover: !!state?.macDeviceId,
    secretsIn,
    lastContactAt: cache.lastContactAt ? new Date(cache.lastContactAt).toISOString() : undefined,
    agentsUrl: agentsBaseUrl(env, state),
  };
  if (isJson(flags)) return print(report);

  if (!state || state.status !== 'active') {
    console.log(`${chalk.bold('Not paired.')} Agents run without asking; only this machine keeps a record.`);
    console.log(chalk.dim('Pair from the arc app: Settings → AI agents → Connect a machine.'));
    console.log(chalk.dim(`Secrets: ${secretsIn}`));
    return;
  }
  console.log(`${chalk.green('●')} Paired as ${chalk.bold(state.label ?? state.hostname)}`);
  console.log(`  ${chalk.dim('words')}        ${state.words.join(' · ')}  ${chalk.dim(state.fingerprint)}`);
  console.log(`  ${chalk.dim('for')}          ${state.intendedClient ? clientDisplay(state.intendedClient) : 'any agent'}`);
  console.log(`  ${chalk.dim('touch id')}     ${state.macDeviceId ? 'enrolled' : 'not enrolled (arc approvals enroll-mac)'}`);
  console.log(`  ${chalk.dim('secrets')}      ${secretsIn}`);
  console.log(`  ${chalk.dim('last contact')} ${report.lastContactAt ?? 'never'}`);
}

/**
 * Forget this machine's pairing. The Actual credentials it was given go too:
 * otherwise "unpair" would be a way for an agent to switch enforcement off.
 */
export async function handleAuthUnpair(flags: Flags, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const state = readConnectionState(env);
  if (!state) {
    console.log('This machine is not paired.');
    return;
  }
  if (flags.yes !== 'true') {
    if (!isInteractive()) throw new Error('Unpairing removes this machine\'s budget access too. Re-run with --yes to confirm.');
    const answer = await promptLine(
      `Unpair ${state.label ?? state.hostname}? This also removes its access to your budget. Type "unpair" to confirm: `
    );
    if (answer.trim() !== 'unpair') {
      console.log('Cancelled.');
      return;
    }
  }
  wipeConnection(env);
  wipeActualSecrets(env);
  try { await mac.remove({ env }); } catch { /* no Mac key */ }
  console.log('Unpaired. Disconnect it on your phone too (Settings → AI agents) so it shows as gone there.');
}

async function promptLine(question: string): Promise<string> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// ── arc approvals ───────────────────────────────────────────────────────────

export interface ApprovalsDeps {
  /** Re-run a CLI command line once its approval has arrived (from index.ts). */
  runParsed: (parsed: ParsedCommand) => Promise<void>;
  runtime?: GateRuntime;
}

export async function handleApprovals(
  sub: string, flags: Flags, positional: string[], deps: ApprovalsDeps
): Promise<number> {
  const rt = deps.runtime ?? createGateRuntime();
  const id = positional[0] || flags.id || flags['request-id'];
  const need = (): string => {
    if (!id || id === 'true') throw new Error(`Usage: arc approvals ${sub} <request-id>`);
    return id;
  };

  if (sub === 'enroll-mac') return enrollMac(rt, flags);
  if (!rt.api || !rt.connection) throw new Error('This machine is not paired. Pair it from the arc app first.');

  switch (sub) {
    case 'list': {
      const { requests } = await rt.api.listPending();
      const local = listPending(rt.env, rt.now());
      if (isJson(flags)) {
        print({ requests, local: local.map(c => ({ request_id: c.requestId, opId: c.opId, summary: c.summary, expires_at: new Date(c.expiresAt).toISOString() })) });
        return 0;
      }
      process.stdout.write(renderPending(requests, { ...defaultRenderOptions(), now: rt.now() }));
      return 0;
    }
    case 'show': {
      const requestId = need();
      const status = await rt.api.requestStatus(requestId);
      const local = loadPending(requestId, rt.env);
      if (isJson(flags)) {
        print({ ...status, local: local ? { summary: local.summary, args: local.args, surface: local.surface } : undefined });
        return 0;
      }
      console.log(`${chalk.bold(local?.summary ?? requestId)}`);
      console.log(`  ${chalk.dim('status')}   ${status.status}${status.scope ? ` · ${status.scope}` : ''}${status.decidedVia ? ` · via ${status.decidedVia}` : ''}`);
      console.log(`  ${chalk.dim('expires')}  ${new Date(status.expiresAt).toLocaleString()}`);
      if (local) {
        console.log(`  ${chalk.dim('from')}     ${clientDisplay(local.client)} over ${local.surface.toUpperCase()}`);
        for (const [key, value] of Object.entries(local.args)) {
          console.log(`  ${chalk.dim(key.padEnd(8))} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
        }
      } else {
        console.log(chalk.dim('  Made on another machine; open it on your phone to see what it does.'));
      }
      return 0;
    }
    case 'approve': {
      const requestId = need();
      const call = loadPending(requestId, rt.env);
      if (!call) throw new Error('Only requests made on this machine can be approved here. Approve this one on your phone.');
      const result = await approveWithMac({ api: rt.api, connection: rt.connection, env: rt.env }, call, parseScope(flags.scope));
      if (result === 'cancelled') {
        console.log('Touch ID cancelled. The request is still waiting for you on your phone.');
        return 0;
      }
      console.log(`${chalk.green('✓')} Approved. ${call.surface === 'cli' ? `Run \`arc approvals wait ${requestId}\` if nothing is waiting on it.` : 'The agent can finish it now.'}`);
      return 0;
    }
    case 'deny': {
      const requestId = need();
      await rt.api.deny(requestId);
      console.log('Denied.');
      return 0;
    }
    case 'wait': {
      const requestId = need();
      const interactive = isInteractive();
      const call = loadPending(requestId, rt.env);
      if (!call) throw new Error(`No call waiting under ${requestId} on this machine.`);
      if (call.surface !== 'cli' || !call.argv) {
        throw new Error(`Request ${requestId} came from ${call.surface.toUpperCase()}; the agent finishes it with arc_agent_request_status.`);
      }
      const wait = interactive ? ttyWait({ touchId: touchIdFor(rt) }) : { maxMs: nonTtyWaitMs(rt.env) };
      try {
        const outcome = await resumePending({
          requestId,
          surface: 'cli',
          runtime: rt,
          wait,
          exec: async (pending) => {
            // The approval covers these exact args: rebuild them from the stored argv and compare.
            const { resolveCliOperation } = await import('./cli-operation.js');
            const resolved = resolveCliOperation(pending.argv!);
            if (resolved.kind !== 'op' || resolved.op.id !== pending.opId) throw new Error('Stored command no longer maps to the approved operation.');
            const rebuilt = JSON.stringify(argsFromArgv(resolved.op, pending.argv!));
            if (rebuilt !== JSON.stringify(pending.args)) throw new Error('Stored command line does not match the approved arguments.');
            await deps.runParsed(pending.argv!);
          },
        });
        if (outcome.status === 'pending') return reportPending(outcome, interactive);
        return 0;
      } catch (error) {
        if (error instanceof AgentDeniedError) return reportDenied(error, interactive);
        throw error;
      }
    }
    default:
      throw new Error('Usage: arc approvals list | show <id> | approve <id> [--scope once|15m|60m|always] | deny <id> | wait <id> | enroll-mac');
  }
}

async function enrollMac(rt: GateRuntime, flags: Flags): Promise<number> {
  if (!rt.api || !rt.connection) throw new Error('Pair this machine first (`arc auth pair`).');
  if (process.platform !== 'darwin') throw new Error('Touch ID approval is macOS-only. On Linux, approvals go to your phone.');
  if (!(await mac.isAvailable({ env: rt.env }))) {
    throw new Error('The arc-approver helper is not installed, or this Mac has no Touch ID. Reinstall arc to get it.');
  }
  let publicKey: string;
  try {
    publicKey = await mac.getPublicKey({ env: rt.env });
  } catch {
    publicKey = (await mac.enroll({ env: rt.env })).publicKey;
  }
  const label = flags.label && flags.label !== 'true' ? flags.label : `${os.hostname()} Touch ID`;
  const { deviceId } = await rt.api.enrollMac({ publicKey, label });
  updateConnectionState({ macDeviceId: deviceId }, rt.env);
  if (isJson(flags)) {
    print({ deviceId, status: 'pending', publicKey });
    return 0;
  }
  console.log(`${BRASS('◆')} ${chalk.bold(label)} is waiting for your approval on your phone.`);
  console.log(chalk.dim('  Once approved, press t while a command waits to approve it with Touch ID.'));
  console.log(chalk.dim('  Destructive changes always go to your phone.'));
  return 0;
}

// ── arc agent (the registry's `agent` group, from the shell) ───────────────

export async function handleAgentGroup(
  sub: string, flags: Flags, deps: ApprovalsDeps
): Promise<number> {
  const rt = deps.runtime ?? createGateRuntime();
  switch (sub) {
    case 'permissions': {
      const report = await describePermissions(detectClientFromEnv(rt.env), rt);
      print(report);
      return 0;
    }
    case 'request-status': {
      const requestId = flags['request-id'] || flags.request_id;
      if (!requestId) throw new Error('Usage: arc agent request-status --request-id <id> [--wait-seconds N]');
      const waitSeconds = Math.min(50, Math.max(0, Number(flags['wait-seconds'] ?? 30) || 0));
      return handleApprovals('wait', { ...flags, json: 'true' }, [requestId], {
        ...deps,
        runtime: { ...rt, env: { ...rt.env, ARC_APPROVAL_WAIT_SECONDS: String(waitSeconds) } },
      });
    }
    default:
      throw new Error('Usage: arc agent permissions | request-status --request-id <id>');
  }
}

// ── arc agents whoami | list ────────────────────────────────────────────────

export async function handleAgents(sub: string, flags: Flags, runtime?: GateRuntime): Promise<number> {
  const rt = runtime ?? createGateRuntime();
  const identity = flags.agent && flags.agent !== 'true'
    ? { key: flags.agent, display: clientDisplay(flags.agent) }
    : detectClientFromEnv(rt.env);

  switch (sub) {
    case 'whoami':
    case 'list': {
      if (sub === 'list') return agentsList(rt, flags);
      if (!rt.api) {
        const report = await describePermissions(identity, rt);
        if (isJson(flags)) print(report);
        else console.log(report.message);
        return 0;
      }
      let self;
      let offline = false;
      try {
        self = await refreshSelf(identity.key, rt);
      } catch (error) {
        if (!(error instanceof AgentUnreachableError)) throw error;
        self = cachedSelf(identity.key, rt.env)?.self ?? null;
        offline = true;
      }
      if (!self) throw new Error('arc is unreachable and has no cached permissions for this agent.');
      if (isJson(flags)) {
        print({ ...(await describePermissions(identity, rt)), offline, self });
        return 0;
      }
      process.stdout.write(renderWhoami(self, { ...defaultRenderOptions(), now: rt.now() }));
      if (offline) console.log(chalk.dim('  (cached — arc is unreachable right now)'));
      return 0;
    }
    default:
      throw new Error('Usage: arc agents whoami [--agent <key>] | list');
  }
}

async function agentsList(rt: GateRuntime, flags: Flags): Promise<number> {
  const entries = readJournal({}, rt.env);
  const byClient = new Map<string, { client: string; last: number; count: number; asked: number; denied: number }>();
  for (const e of entries) {
    const row = byClient.get(e.client) ?? { client: e.client, last: 0, count: 0, asked: 0, denied: 0 };
    row.count++;
    row.last = Math.max(row.last, e.at);
    if (e.decision === 'pending') row.asked++;
    if (e.decision === 'deny') row.denied++;
    byClient.set(e.client, row);
  }
  const rows = [...byClient.values()].sort((a, b) => b.last - a.last);
  const withPolicy = rows.map(r => ({ ...r, preset: cachedSelf(r.client, rt.env)?.self.policy.preset }));
  if (isJson(flags)) {
    print(withPolicy.map(r => ({ ...r, name: clientDisplay(r.client), last: new Date(r.last).toISOString() })));
    return 0;
  }
  if (rows.length === 0) {
    console.log(chalk.dim('No agent has used arc on this machine yet.'));
    return 0;
  }
  const live = 2 * 60 * 1000;
  for (const r of withPolicy) {
    const dot = rt.now() - r.last < live ? chalk.green('●') : chalk.dim('○');
    const extras = [
      `${r.count} ${r.count === 1 ? 'action' : 'actions'}`,
      r.asked ? BRASS(`${r.asked} asked`) : null,
      r.denied ? VERMILION(`${r.denied} denied`) : null,
      r.preset ? chalk.dim(r.preset) : null,
    ].filter(Boolean).join(chalk.dim(' · '));
    console.log(`${dot} ${chalk.bold(clientDisplay(r.client).padEnd(16))} ${extras}  ${chalk.dim(new Date(r.last).toLocaleString())}`);
  }
  return 0;
}

// ── arc activity ────────────────────────────────────────────────────────────

/** arcreactor serves at most 200 rows per /activity page. */
const PAGE_LIMIT = 200;
const MAX_PAGES = 25;
const CACHE_ROWS = 5000;

interface AuditCache {
  rows: AuditRowWire[];
  head?: AuditHeadWire;
  /**
   * The last row dropped when the cache was trimmed, after it had been
   * verified from the anchor. The kept rows must continue from it.
   */
  checkpoint?: { seq: number; hash: string };
}

/** Pull new audit rows after the cached ones; the cache keeps the chain contiguous for verification. */
async function syncAudit(rt: GateRuntime): Promise<AuditCache> {
  const file = agentPaths(rt.env).auditCache;
  let cache: AuditCache = { rows: [] };
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first sync */ }
  let afterSeq = cache.rows.length ? cache.rows[cache.rows.length - 1].seq : 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await rt.api!.activity({ afterSeq, limit: PAGE_LIMIT });
    cache.head = result.head;
    const fresh = result.entries.filter(e => e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
    cache.rows.push(...fresh);
    if (fresh.length) afterSeq = fresh[fresh.length - 1].seq;
    if (fresh.length < PAGE_LIMIT) break;
  }
  if (cache.rows.length > CACHE_ROWS) {
    // Only trim what verifies; a broken cache keeps everything so the break stays visible.
    const verdict = verifyCache(cache);
    if (verdict.ok) {
      const dropped = cache.rows[cache.rows.length - CACHE_ROWS - 1];
      cache.checkpoint = { seq: dropped.seq, hash: dropped.hash };
      cache.rows = cache.rows.slice(-CACHE_ROWS);
    }
  }
  try {
    fs.mkdirSync(agentPaths(rt.env).home, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache), { mode: 0o600 });
  } catch { /* the cache only saves bandwidth */ }
  return cache;
}

/**
 * Verify the cached rows. From the anchor when the cache holds the whole
 * retained chain (verifyChain with the head); after a trim, from the
 * checkpoint of the last dropped row, which was verified before it was dropped.
 */
export function verifyCache(cache: AuditCache): ChainVerdict {
  if (!cache.checkpoint || !cache.rows.length) return verifyChain(cache.rows, cache.head);
  const first = cache.rows[0];
  if (first.seq !== cache.checkpoint.seq + 1) return { ok: false, verifiedThrough: cache.checkpoint.seq, breakAt: first.seq, reason: 'gap' };
  if (first.prevHash !== cache.checkpoint.hash) return { ok: false, verifiedThrough: cache.checkpoint.seq, breakAt: first.seq, reason: 'link' };
  const inner = verifyChain(cache.rows);
  if (!inner.ok) return inner;
  const last = cache.rows[cache.rows.length - 1];
  if (cache.head && last.seq === cache.head.seq && last.hash !== cache.head.hash) {
    return { ok: false, verifiedThrough: inner.verifiedThrough, breakAt: last.seq, reason: 'head' };
  }
  return inner;
}

/**
 * The newest `limit` rows, plus any older row of a request they show. A cut
 * that kept an action but dropped its approval rendered the action as still
 * "waiting on you".
 */
export function withRequestSiblings<T extends { requestId?: string }>(sorted: T[], limit: number): T[] {
  const tail = sorted.slice(-limit);
  const ids = new Set(tail.map(r => r.requestId).filter(Boolean));
  if (!ids.size) return tail;
  const head = sorted.slice(0, Math.max(0, sorted.length - limit)).filter(r => r.requestId && ids.has(r.requestId));
  return [...head, ...tail];
}

/** "2h", "3d", "45m", or an ISO date → ms since epoch. */
export function parseSince(value: string | undefined, now: number): number | undefined {
  if (!value || value === 'true') return undefined;
  const rel = /^(\d+)\s*(m|h|d|w)$/i.exec(value.trim());
  if (rel) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase() as 'm' | 'h' | 'd' | 'w'];
    return now - Number(rel[1]) * unit;
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`Cannot read --since "${value}". Use 2h, 3d, or a date like 2026-10-01.`);
  return t;
}

/** Journal entries with no server row, as timeline rows: an unpaired install's whole history. */
export function journalRows(entries: JournalEntry[]): AuditRowWire[] {
  return entries
    .filter(e => e.decision === 'local' || (e.offline && !e.auditId))
    .map((e) => ({
      id: `local:${e.id}`,
      seq: 0,
      userId: '',
      at: e.at,
      kind: e.decision === 'deny' ? 'op.denied' : 'op.completed',
      connectionId: e.connectionId,
      client: e.client,
      opId: e.opId,
      group: e.group,
      risk: e.risk,
      decision: e.decision === 'deny' ? 'deny' : 'allow',
      source: 'agent',
      detail: { result: e.outcome === 'error' ? 'error' : e.outcome === 'ok' ? 'ok' : undefined, offline: e.offline, surface: e.surface },
      prevHash: '',
      hash: '',
    }) as AuditRowWire);
}

export async function handleActivity(flags: Flags, runtime?: GateRuntime): Promise<number> {
  const rt = runtime ?? createGateRuntime();
  const now = rt.now();
  const since = parseSince(flags.since, now);
  const client = flags.agent && flags.agent !== 'true' ? flags.agent : undefined;
  const limit = flags.limit ? Math.max(1, Number.parseInt(flags.limit, 10) || 200) : 200;
  const journal = readJournal({}, rt.env);
  const lookup = journalLookup(journal);

  let server: AuditRowWire[] = [];
  let head: AuditHeadWire | undefined;
  let checkpoint: AuditCache['checkpoint'];
  let offline = false;
  if (rt.api) {
    try {
      const cache = await syncAudit(rt);
      ({ rows: server, head, checkpoint } = cache);
    } catch (error) {
      if (!(error instanceof AgentUnreachableError)) throw error;
      offline = true;
      try {
        const cache = JSON.parse(fs.readFileSync(agentPaths(rt.env).auditCache, 'utf8')) as AuditCache;
        ({ rows: server, head, checkpoint } = cache);
      } catch { /* nothing cached */ }
    }
  }
  // Verify over everything we hold, from the anchor (or the trim checkpoint), then filter for display.
  const verdict = head ? verifyCache({ rows: server, head, checkpoint }) : undefined;
  const keep = (row: AuditRowWire) =>
    (since == null || row.at >= since) && (!client || row.client === client);
  const all = [...server, ...journalRows(journal.filter(e => !rt.connection || e.decision === 'local'))]
    .filter(keep)
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
  const rows = withRequestSiblings(all, limit);

  if (isJson(flags)) {
    print({
      entries: rows.map(r => ({ ...r, local: lookup.lookup(r)?.summary })),
      head,
      chain: verdict,
      offline,
      paired: !!rt.connection,
    });
    return 0;
  }

  const opts = { ...defaultRenderOptions(), now, verdict, head };
  const connections = rt.connection
    ? { [rt.connection.state.connectionId]: { label: rt.connection.state.label, hostname: rt.connection.state.hostname, intendedClient: rt.connection.state.intendedClient } }
    : undefined;
  const first = renderActivityFrom(rows, lookup, { ...opts, connections });
  process.stdout.write(first.text);
  if (offline) console.log(chalk.dim('  arc is unreachable; showing what this machine already had.'));
  if (!rt.connection) console.log(chalk.dim('  This machine is not paired; this is its own record only.'));

  if (flags.follow !== 'true' || !rt.api) return 0;
  let cursor = first.cursor;
  const lastSeq = server.length ? server[server.length - 1].seq : 0;
  const handle = followActivity(rt.api, (entries, newHead) => {
    const fresh = entries.filter(keep);
    if (!fresh.length) return;
    const next = renderActivityFrom(fresh, journalLookup(readJournal({}, rt.env)), { ...opts, now: Date.now(), head: newHead, connections }, cursor, { footer: false });
    cursor = next.cursor;
    process.stdout.write(next.text);
  }, 3000, { afterSeq: lastSeq, limit: PAGE_LIMIT });
  await new Promise<void>(resolve => {
    process.once('SIGINT', () => { handle.stop(); resolve(); });
  });
  return 0;
}

