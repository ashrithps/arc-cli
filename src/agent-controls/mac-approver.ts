// Touch ID approvals on this Mac, through the native `arc-approver` helper
// (native/arc-approver/main.swift). The helper holds a Secure Enclave P-256
// key that signs only after a Touch ID match; this module spawns it and builds
// the exact bytes it signs.
//
// Contract: docs/agent-controls/2026-10-05-agent-controls.md §4.4, §4.6, §4.7.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getArcHome } from '../runtime-paths.js';

export type MacApproverErrorCode =
  | 'usage'
  | 'no_key'
  | 'cancelled'
  | 'unavailable'
  | 'invalidated'
  | 'failed'
  | 'timeout'
  | 'not_installed';

const EXIT_CODES: Record<number, MacApproverErrorCode> = {
  2: 'usage',
  3: 'no_key',
  4: 'cancelled',
  5: 'unavailable',
  6: 'invalidated',
};

export class MacApproverError extends Error {
  constructor(
    readonly code: MacApproverErrorCode,
    message: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'MacApproverError';
  }
}

// The user is sitting at the Touch ID prompt, so give them time.
export const SIGN_TIMEOUT_MS = 120_000;
const QUICK_TIMEOUT_MS = 10_000;
const MAX_REASON_LENGTH = 200;

export function helperPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ARC_APPROVER_BIN) return env.ARC_APPROVER_BIN;
  const installed = path.join(getArcHome(env), 'bin', 'arc-approver');
  if (isExecutable(installed)) return installed;
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'arc-approver');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

interface RunOptions {
  stdin?: Uint8Array;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function runHelper(args: string[], options: RunOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const bin = helperPath(env);
  if (!bin) {
    return Promise.reject(new MacApproverError('not_installed', 'arc-approver is not installed'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, ARC_CONFIG_DIR: getArcHome(env) },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs ?? QUICK_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' || error.code === 'EACCES'
        ? new MacApproverError('not_installed', `arc-approver could not be started: ${error.code}`)
        : new MacApproverError('failed', error.message));
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new MacApproverError('timeout', 'Touch ID approval timed out'));
        return;
      }
      if (exitCode === 0) {
        resolve(stdout.trim());
        return;
      }
      const detail = parseHelperError(stderr);
      const code = (exitCode !== null && EXIT_CODES[exitCode]) || 'failed';
      reject(new MacApproverError(code, detail || `arc-approver exited with ${exitCode}`, exitCode ?? undefined));
    });

    // An early-exiting helper closes stdin under us; the exit code says why.
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin ? Buffer.from(options.stdin) : undefined);
  });
}

function parseHelperError(stderr: string): string {
  const line = stderr.trim().split('\n').pop() || '';
  try {
    const parsed = JSON.parse(line) as { message?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // not JSON: fall through to the raw text
  }
  return line;
}

let availability: Promise<boolean> | null = null;

export function isAvailable(
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return Promise.resolve(false);
  const probe = () => runHelper(['available'], { env: options.env })
    .then((out) => {
      const parsed = JSON.parse(out) as { secureEnclave?: unknown; biometry?: unknown };
      return parsed.secureEnclave === true && parsed.biometry === 'touchID';
    })
    .catch(() => false);
  if (options.env) return probe();
  availability ??= probe();
  return availability;
}

export function resetAvailabilityCache(): void {
  availability = null;
}

/** Creates the Secure Enclave key. Refuses to replace an existing one unless `force`. */
export async function enroll(options: { force?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<{ publicKey: string }> {
  const out = await runHelper(options.force ? ['create', '--force'] : ['create'], { env: options.env });
  return { publicKey: checkB64url(out, 'public key') };
}

export async function getPublicKey(options: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return checkB64url(await runHelper(['pubkey'], { env: options.env }), 'public key');
}

export async function remove(options: { env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  await runHelper(['delete'], { env: options.env });
}

/**
 * Shows the Touch ID prompt and returns the DER signature, base64url. The
 * message goes over stdin, never argv. `reason` is visible in the prompt and in
 * `ps`, so it carries only the enum summary (see approvalReason), never
 * amounts, payees or notes.
 */
export async function sign(
  message: Uint8Array,
  reason: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string> {
  if (message.length === 0) throw new MacApproverError('usage', 'nothing to sign');
  if (!reason || reason.length > MAX_REASON_LENGTH || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new MacApproverError('usage', 'the Touch ID reason must be one short line');
  }
  const out = await runHelper(['sign', '--reason', reason], {
    stdin: message,
    env: options.env,
    timeoutMs: options.timeoutMs ?? SIGN_TIMEOUT_MS,
  });
  return checkB64url(out, 'signature');
}

/** "approve: Claude Code wants to delete transaction" from a `<verb>:<noun>` summaryEnum. */
export function approvalReason(clientDisplayName: string, summaryEnum: string): string {
  const [verb, noun] = summaryEnum.split(':');
  const what = [verb, noun].filter(Boolean).join(' ').replace(/[_-]+/g, ' ');
  return `approve: ${clientDisplayName} wants to ${what}`.replace(/\s+/g, ' ').slice(0, MAX_REASON_LENGTH);
}

function checkB64url(value: string, what: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new MacApproverError('failed', `arc-approver returned a malformed ${what}`);
  }
  return value;
}

// ---- Signed message bytes ----

export interface ApprovalMessageFields {
  requestId: string;
  opHash: string;
  decision: 'approve';
  scope: 'once' | 'minutes' | 'always';
  scopeMinutes: number;
  nonce: string;
  expiresAt: number;
  deviceId: string;
}

export interface EnrollMessageFields {
  newDeviceId: string;
  newPublicKey: string;
  nonce: string;
  expiresAt: number;
  deviceId: string;
}

/** §4.4 — the bytes an approver signs to approve a request. */
export function buildApprovalMessage(fields: ApprovalMessageFields): Uint8Array {
  if (fields.decision !== 'approve') throw new Error('only approvals are signed');
  if (!['once', 'minutes', 'always'].includes(fields.scope)) throw new Error(`bad scope: ${fields.scope}`);
  if (fields.scope === 'minutes' ? ![15, 60].includes(fields.scopeMinutes) : fields.scopeMinutes !== 0) {
    throw new Error(`bad scopeMinutes ${fields.scopeMinutes} for scope ${fields.scope}`);
  }
  return encodeLines([
    'arc-approval-v1',
    fields.requestId,
    fields.opHash,
    fields.decision,
    fields.scope,
    decimal(fields.scopeMinutes),
    fields.nonce,
    decimal(fields.expiresAt),
    fields.deviceId,
  ]);
}

/** §4.6 — the bytes an existing approver signs to add another device. */
export function buildEnrollMessage(fields: EnrollMessageFields): Uint8Array {
  return encodeLines([
    'arc-enroll-v1',
    fields.newDeviceId,
    fields.newPublicKey,
    fields.nonce,
    decimal(fields.expiresAt),
    fields.deviceId,
  ]);
}

function decimal(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`expected a non-negative integer, got ${value}`);
  return String(value);
}

function encodeLines(lines: string[]): Uint8Array {
  for (const line of lines) {
    // A field holding a newline could forge the fields after it.
    if (typeof line !== 'string' || line === '' || line.includes('\n')) {
      throw new Error('signed message fields must be non-empty single-line strings');
    }
  }
  return new TextEncoder().encode(lines.join('\n'));
}
