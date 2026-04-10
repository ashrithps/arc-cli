import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

export interface SessionStatus {
  pid: number;
  socketPath: string;
  startedAt: string;
  cwd: string;
  budgetRef?: string;
  budgetGroupId?: string;
  budgetName?: string;
}

export interface DaemonResponse {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

function getRuntimeDir(): string {
  const dir = path.join(os.tmpdir(), 'arc-daemon');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSocketPath(): string {
  return path.join(getRuntimeDir(), 'daemon.sock');
}

export function getStatusPath(): string {
  return path.join(getRuntimeDir(), 'daemon.json');
}

export function getLogPath(): string {
  return path.join(getRuntimeDir(), 'daemon.log');
}

export function readStatus(): SessionStatus | null {
  try {
    return JSON.parse(fs.readFileSync(getStatusPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function writeStatus(status: SessionStatus): void {
  fs.writeFileSync(getStatusPath(), JSON.stringify(status, null, 2));
}

export function clearStatus(): void {
  try { fs.unlinkSync(getStatusPath()); } catch {}
  try { fs.unlinkSync(getSocketPath()); } catch {}
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonRunning(): boolean {
  const status = readStatus();
  const running = !!(status && isProcessAlive(status.pid) && fs.existsSync(status.socketPath));
  if (!running && status) {
    clearStatus();
  }
  return running;
}

export async function waitForDaemon(timeoutMs: number = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isDaemonRunning()) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

export function startDaemonProcess(cwd: string, budgetRef?: string): void {
  clearStatus();
  const logFd = fs.openSync(getLogPath(), 'a');
  const daemonEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'session-daemon.ts');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', daemonEntry],
    {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        ARC_DAEMON_SOCKET: getSocketPath(),
        ...(budgetRef ? { ARC_DAEMON_BUDGET: budgetRef } : {}),
        ARC_CONNECT_RETRIES: process.env.ARC_CONNECT_RETRIES || '10',
        ARC_SYNC_RETRIES: process.env.ARC_SYNC_RETRIES || '10',
        ARC_RETRY_BASE_DELAY_MS: process.env.ARC_RETRY_BASE_DELAY_MS || '2500',
      },
    }
  );
  child.unref();
  fs.closeSync(logFd);
}

export function stopDaemonProcess(): boolean {
  const status = readStatus();
  if (!status) {
    clearStatus();
    return false;
  }
  try {
    process.kill(status.pid, 'SIGTERM');
  } catch {}
  clearStatus();
  return true;
}

export async function sendDaemonRequest(payload: unknown, timeoutMs: number = 30000): Promise<DaemonResponse> {
  const status = readStatus();
  if (!status || !fs.existsSync(status.socketPath)) {
    throw new Error('Arc daemon is not running.');
  }

  return await new Promise((resolve, reject) => {
    const client = net.createConnection(status.socketPath);
    let data = '';
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('Timed out waiting for Arc daemon response.'));
    }, timeoutMs);

    client.on('connect', () => {
      client.write(`${JSON.stringify(payload)}\n`);
    });
    client.on('data', chunk => {
      data += chunk.toString();
    });
    client.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    client.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
