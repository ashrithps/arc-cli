import type { ActualClient } from './client.js';
import type { BackupManager } from './backup.js';
import type { WriteResult } from './types.js';

export class SafeWriter {
  constructor(
    private client: ActualClient,
    private backup: BackupManager
  ) {}

  async write<T>(operation: string, fn: () => Promise<T>): Promise<WriteResult<T>> {
    this.client.ensureConnected();
    const releaseLock = await this.client.acquireWriteLock(operation);

    try {
      // Always sync into a fresh session before mutating state.
      await this.client.prepareForWrite();

      // Create backup on first write of the session
      const backupPath = await this.backup.ensureBackup(this.client);
      console.error(`[Write] ${operation}`);
      const result = await fn();

      // Post-write sync retries in-place so we don't replay the mutation.
      await this.client.sync({ attempts: 5, rebuildSessionOnRetry: false });

      return { success: true, data: result, backupPath };
    } catch (error: any) {
      const msg = error?.message || String(error);
      console.error(`[Write] FAILED: ${operation} — ${msg}`);
      return { success: false, error: msg, backupPath: this.backup.getSessionBackup() || undefined };
    } finally {
      releaseLock();
    }
  }
}
