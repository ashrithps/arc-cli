/**
 * Waiting for approval in a terminal.
 *
 * TTY: one live line on stderr — spinner, what is waiting, time left — with
 * `[t]` to approve right here with Touch ID (when this Mac is an approver and
 * the risk allows it) and Ctrl-C to cancel the request. Non-TTY: wait
 * `ARC_APPROVAL_WAIT_SECONDS` (default 90) in silence and let the caller exit
 * 75 with JSON pointing at `arc approvals wait`.
 */
import chalk from 'chalk';
import type { WaitOptions } from './gate.js';
import type { PendingCall } from './pending.js';

export const DEFAULT_NON_TTY_WAIT_S = 90;
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BRASS = chalk.hex('#C9A44C');

export function nonTtyWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.ARC_APPROVAL_WAIT_SECONDS ?? '', 10);
  return (Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_NON_TTY_WAIT_S) * 1000;
}

export function isInteractive(): boolean {
  return !!(process.stdin.isTTY && process.stderr.isTTY);
}

function remaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface TtyWaitOptions {
  /** Offered as `[t]` when present. Resolves once the approval is sent. */
  touchId?: (call: PendingCall) => Promise<'approved' | 'cancelled'>;
  now?: () => number;
}

/**
 * Wait options for an interactive terminal. The wait runs to the request's
 * own expiry: a person at the keyboard is the one who will decide.
 */
export function ttyWait(options: TtyWaitOptions = {}): WaitOptions {
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let onData: ((chunk: Buffer) => void) | null = null;
  let status = '';
  let frame = 0;
  let current: PendingCall | null = null;
  let busy = false;

  const draw = () => {
    if (!current) return;
    const keys = [options.touchId ? `${chalk.bold('t')} Touch ID` : null, `${chalk.bold('ctrl-c')} cancel`].filter(Boolean).join('  ');
    const line = `${BRASS(FRAMES[frame++ % FRAMES.length])} ${status || 'Waiting for your approval on your phone'}` +
      chalk.dim(` · ${current.summary} · ${remaining(current.expiresAt - now())} left   ${keys}`);
    process.stderr.write(`\r\x1b[2K${line.slice(0, (process.stderr.columns || 120) + 40)}`);
  };

  return {
    maxMs: 11 * 60 * 1000,
    signal: controller.signal,
    onPending(call, reused) {
      current = call;
      process.stderr.write(
        `${BRASS('◆')} ${reused ? 'Still waiting' : 'Approval needed'} — ${call.summary}\n`
      );
      timer = setInterval(draw, 100);
      draw();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        onData = (chunk: Buffer) => {
          const key = chunk.toString('utf8');
          if (key === '\u0003') {
            status = 'Cancelling…';
            controller.abort();
          } else if ((key === 't' || key === 'T') && options.touchId && !busy && current) {
            busy = true;
            status = 'Touch ID…';
            options.touchId(current).then(
              (result) => { status = result === 'cancelled' ? '' : 'Approved on this Mac — finishing'; },
              (error: unknown) => {
                status = '';
                process.stderr.write(`\r\x1b[2K${chalk.hex('#E5533D')('✗')} ${error instanceof Error ? error.message : String(error)}\n`);
              }
            ).finally(() => { busy = false; });
          }
        };
        process.stdin.on('data', onData);
      }
    },
    onSettled() {
      if (timer) clearInterval(timer);
      timer = null;
      if (onData) process.stdin.off('data', onData);
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch { /* not a TTY any more */ }
        process.stdin.pause();
      }
      if (current) process.stderr.write('\r\x1b[2K');
      current = null;
    },
  };
}
