/**
 * Server lifecycle.
 *
 * Arc's managed servers run on Cloud Run with `minScale: 0`, so an instance
 * that has been idle is genuinely stopped and the next request pays a cold
 * start. Every command absorbs that automatically (see
 * `ActualClient.waitForServer`), but an agent driving the MCP server benefits
 * from being able to do it deliberately: MCP clients impose their own request
 * timeouts, and a cheap warm-up call is far more likely to finish inside one
 * than a cold-start plus a multi-megabyte budget download.
 */
import type { ActualClient } from '../client.js';

export interface WakeResult {
  ready: boolean;
  elapsedMs: number;
  attempts: number;
  /** True when the server had to start, rather than already being up. */
  wasCold: boolean;
  /** Human-readable summary, so agents do not have to phrase it themselves. */
  summary: string;
}

export async function wakeServer(
  client: ActualClient,
  options: { timeoutMs?: number } = {}
): Promise<WakeResult> {
  const result = await client.waitForServer({ timeoutMs: options.timeoutMs });
  const secs = (result.elapsedMs / 1000).toFixed(1);

  const summary = !result.ready
    ? `Server did not respond within ${secs}s after ${result.attempts} attempts. It may still be starting.`
    : result.wasCold
      ? `Server was asleep and is now ready (took ${secs}s).`
      : `Server was already awake (${Math.round(result.elapsedMs)}ms).`;

  return { ...result, summary };
}
