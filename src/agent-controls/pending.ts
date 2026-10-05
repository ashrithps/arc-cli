/**
 * Calls waiting for the user's decision, persisted so that the run that
 * finishes them executes exactly what was approved.
 *
 * `~/.arc-cli/pending/<requestId>.json`, mode 0600. The file holds the args
 * the opHash was computed over; a resume recomputes the hash and refuses to
 * run if the file was edited, because the phone approved that hash and
 * nothing else. The server's single-use `consume` makes "once" hold across
 * processes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { agentPaths, readJsonFile, writePrivateJson } from './connection.js';
import type { ParsedCommand } from './cli-operation.js';
import type { Risk, Surface } from './wire.js';

export interface PendingCall {
  requestId: string;
  opId: string;
  group: string;
  risk: Risk;
  opHash: string;
  surface: Surface;
  client: string;
  budget: string;
  budgetName?: string;
  args: Record<string, unknown>;
  /** CLI calls only: the command line to re-run once approved. */
  argv?: ParsedCommand;
  summary: string;
  summaryEnum: string;
  createdAt: number;
  expiresAt: number;
}

function fileFor(requestId: string, env: NodeJS.ProcessEnv): string {
  // Request ids are server-issued; keep them from naming a path elsewhere.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error(`Invalid request id: ${requestId}`);
  return path.join(agentPaths(env).pendingDir, `${requestId}.json`);
}

export function savePending(call: PendingCall, env: NodeJS.ProcessEnv = process.env): void {
  writePrivateJson(fileFor(call.requestId, env), call);
}

export function loadPending(requestId: string, env: NodeJS.ProcessEnv = process.env): PendingCall | null {
  return readJsonFile<PendingCall>(fileFor(requestId, env));
}

export function deletePending(requestId: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.rmSync(fileFor(requestId, env), { force: true });
  } catch { /* invalid id: nothing to delete */ }
}

/** Newest first. Expired files older than a day are swept on the way. */
export function listPending(env: NodeJS.ProcessEnv = process.env, now = Date.now()): PendingCall[] {
  const dir = agentPaths(env).pendingDir;
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: PendingCall[] = [];
  for (const name of names) {
    const call = readJsonFile<PendingCall>(path.join(dir, name));
    if (!call) continue;
    if (call.expiresAt < now - 24 * 60 * 60 * 1000) {
      fs.rmSync(path.join(dir, name), { force: true });
      continue;
    }
    out.push(call);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
