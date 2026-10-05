/**
 * TUI writes, gated.
 *
 * The TUI used to call `client.api.*` directly: no Agent Controls, no
 * pre-write sync, no session backup. Every write now goes through
 * `gatedWrite`, which runs the gate (surface "tui") and then SafeWriter. A
 * call that needs approval shows a small modal — waiting on the phone, `t`
 * for Touch ID, Esc to cancel — and the TUI keeps running behind it.
 *
 * `tests/gate-coverage.test.ts` fails if app.ts makes a mutating API call
 * anywhere but inside a `gatedWrite(...)` callback.
 */
import blessed from 'blessed';
import type { ActualClient } from '../client.js';
import { BackupManager } from '../backup.js';
import { SafeWriter } from '../safe-writer.js';
import { approveWithMac } from '../agent-controls/approve-mac.js';
import { operationById } from '../agent-controls/cli-operation.js';
import { detectClientFromEnv } from '../agent-controls/client-identity.js';
import { AgentDeniedError, createGateRuntime, runGated } from '../agent-controls/gate.js';
import type { PendingCall } from '../agent-controls/pending.js';

export interface TuiGateDeps {
  screen: any;
  client: () => ActualClient;
  budgetName: () => string | undefined;
  /** Status-bar line, blessed tags allowed. */
  status: (message: string) => void;
  colors: { brass: string; vermilion: string; muted: string; fg: string; bg: string };
}

export type GatedWrite = <T>(
  opId: string,
  args: Record<string, unknown>,
  label: string,
  fn: () => Promise<T>,
  options?: { viaWriter?: boolean }
) => Promise<{ ok: true; result: T } | { ok: false }>;

export function createTuiGate(deps: TuiGateDeps): GatedWrite {
  const backup = new BackupManager();
  let writer: SafeWriter | null = null;
  let writerFor: ActualClient | null = null;
  const writerOf = (client: ActualClient) => {
    if (!writer || writerFor !== client) {
      writer = new SafeWriter(client, backup);
      writerFor = client;
    }
    return writer;
  };
  const { brass, vermilion, muted } = deps.colors;
  const esc = (s: string) => s.replace(/[{}]/g, c => (c === '{' ? '{open}' : '{close}'));

  return async function gatedWrite(opId, args, label, fn, options = {}) {
    const op = operationById(opId);
    if (!op) throw new Error(`Unknown operation ${opId}`);
    const client = deps.client();
    const runtime = createGateRuntime();

    let modal: any = null;
    let ticker: NodeJS.Timeout | null = null;
    const controller = new AbortController();

    try {
      const outcome = await runGated({
        op,
        args,
        surface: 'tui',
        client: detectClientFromEnv(),
        budget: client.getConfig().budgetSyncId ?? '',
        budgetName: deps.budgetName(),
        runtime,
        exec: async () => {
          if (options.viaWriter === false) return fn();
          const written = await writerOf(client).write(label, fn);
          if (!written.success) throw new Error(written.error ?? `${label} failed`);
          return written.data as Awaited<ReturnType<typeof fn>>;
        },
        wait: {
          maxMs: 11 * 60 * 1000,
          signal: controller.signal,
          onPending: (call: PendingCall) => {
            const canTouch = !!(runtime.api && runtime.connection?.state.macDeviceId && process.platform === 'darwin');
            let note = '';
            modal = blessed.box({
              parent: deps.screen, top: 'center', left: 'center', width: 64, height: 9,
              label: ' Approval needed ', tags: true, border: { type: 'line' },
              style: { bg: deps.colors.bg, fg: deps.colors.fg, border: { fg: brass }, label: { fg: brass, bold: true } },
            });
            const draw = () => {
              const left = Math.max(0, Math.ceil((call.expiresAt - runtime.now()) / 1000));
              modal.setContent([
                '',
                `  {${brass}-fg}◆{/${brass}-fg} ${esc(call.summary)}`,
                `  {${muted}-fg}Waiting for you on your phone · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left{/${muted}-fg}`,
                note ? `  ${note}` : '',
                '',
                `  ${canTouch ? '{bold}t{/bold} Touch ID   ' : ''}{bold}esc{/bold} cancel`,
              ].join('\n'));
              deps.screen.render();
            };
            ticker = setInterval(draw, 1000);
            modal.key(['escape'], () => controller.abort());
            if (canTouch) {
              modal.key(['t'], () => {
                note = 'Touch ID…';
                draw();
                approveWithMac({ api: runtime.api!, connection: runtime.connection! }, call).then(
                  (result) => { note = result === 'cancelled' ? '' : `{green-fg}Approved on this Mac{/green-fg}`; draw(); },
                  (error: unknown) => { note = `{${vermilion}-fg}${esc(error instanceof Error ? error.message : String(error))}{/${vermilion}-fg}`; draw(); },
                );
              });
            }
            modal.focus();
            draw();
          },
          onSettled: () => {
            if (ticker) clearInterval(ticker);
            if (modal) modal.destroy();
            modal = null;
            deps.screen.render();
          },
        },
      });
      if (outcome.status === 'pending') {
        deps.status(`{${brass}-fg}◆ Still waiting for approval{/${brass}-fg}`);
        return { ok: false };
      }
      return { ok: true, result: outcome.result as Awaited<ReturnType<typeof fn>> };
    } catch (error) {
      if (error instanceof AgentDeniedError) {
        deps.status(`{${vermilion}-fg}✗ ${esc(error.message)}{/${vermilion}-fg}`);
        return { ok: false };
      }
      throw error;
    }
  } as GatedWrite;
}
