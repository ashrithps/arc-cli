import 'dotenv/config';
import * as fs from 'fs';
import * as net from 'net';
import { ActualClient } from './client.js';
import { BackupManager } from './backup.js';
import { SafeWriter } from './safe-writer.js';
import { executeParsedCommand, type ParsedArgs } from './index.js';
import { clearStatus, getSocketPath, writeStatus } from './session-manager.js';

const socketPath = process.env.ARC_DAEMON_SOCKET || getSocketPath();

async function main() {
  try { fs.unlinkSync(socketPath); } catch {}

  const client = ActualClient.fromEnv();
  if (process.env.ARC_DAEMON_BUDGET) {
    client.selectBudget(process.env.ARC_DAEMON_BUDGET);
  }
  const backup = new BackupManager();
  const writer = new SafeWriter(client, backup);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.connect();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 4000 * attempt));
      }
    }
  }
  if (lastError) {
    throw lastError;
  }

  const budgetContext = client.getBudgetContext();
  writeStatus({
    pid: process.pid,
    socketPath,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    budgetRef: process.env.ARC_DAEMON_BUDGET,
    budgetGroupId: budgetContext?.groupId,
    budgetName: budgetContext?.name,
  });

  let queue = Promise.resolve();

  const server = net.createServer(conn => {
    let body = '';
    let handled = false;
    conn.on('error', error => {
      console.error(`Daemon connection error: ${error instanceof Error ? error.message : String(error)}`);
    });
    conn.on('data', chunk => {
      body += chunk.toString();
      if (handled || !body.includes('\n')) {
        return;
      }
      handled = true;
      body = body.slice(0, body.indexOf('\n'));
      queue = queue.then(async () => {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const origLog = console.log;
        const origErr = console.error;
        console.log = (...args) => { stdout.push(args.join(' ')); };
        console.error = (...args) => { stderr.push(args.join(' ')); };

        try {
          if (!body.trim()) {
            conn.end(JSON.stringify({ ok: false, stdout: '', stderr: '', error: 'Empty daemon request.' }));
            return;
          }
          const parsed = JSON.parse(body) as ParsedArgs;
          await executeParsedCommand(parsed, client, writer);
          conn.end(JSON.stringify({ ok: true, stdout: stdout.join('\n'), stderr: stderr.join('\n') }));
        } catch (error) {
          console.error(`Daemon request failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
          conn.end(JSON.stringify({
            ok: false,
            stdout: stdout.join('\n'),
            stderr: stderr.join('\n'),
            error: error instanceof Error ? error.message : String(error),
          }));
        } finally {
          console.log = origLog;
          console.error = origErr;
        }
      }).catch(() => {});
    });
  });
  server.on('error', error => {
    console.error(`Daemon server error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  });

  const shutdown = async () => {
    server.close();
    try { await client.disconnect(); } catch {}
    clearStatus();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(socketPath);
}

process.on('uncaughtException', error => {
  console.error(`Daemon uncaught exception: ${error.stack || error.message}`);
});
process.on('unhandledRejection', reason => {
  console.error(`Daemon unhandled rejection: ${String(reason)}`);
});

main().catch(async error => {
  console.error(error instanceof Error ? error.message : String(error));
  clearStatus();
  process.exit(1);
});
