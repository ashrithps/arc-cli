import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ActualClient } from './client.js';

export class BackupManager {
  private backupDir: string;
  private sessionBackupPath: string | null = null;

  constructor(backupDir: string = './backups') {
    this.backupDir = path.resolve(backupDir);
  }

  async ensureBackup(client: ActualClient): Promise<string> {
    if (this.sessionBackupPath) return this.sessionBackupPath;

    // Ensure backup directory exists
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }

    const budgetDir = client.getBudgetDataDir();

    if (!budgetDir || !fs.existsSync(budgetDir)) {
      throw new Error('Budget data directory not found for the active session. Run connect first.');
    }

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(this.backupDir, `backup-${timestamp}.zip`);

    try {
      execSync(
        `cd "${budgetDir}" && zip -r "${path.resolve(backupFile)}" . -x "*.DS_Store"`,
        { stdio: 'pipe', timeout: 30000 }
      );
    } catch (err) {
      // Fallback: copy directory as tar.gz if zip not available
      try {
        const tarFile = backupFile.replace('.zip', '.tar.gz');
        execSync(
          `tar -czf "${path.resolve(tarFile)}" -C "${budgetDir}" .`,
          { stdio: 'pipe', timeout: 30000 }
        );
        this.sessionBackupPath = tarFile;
        client.markBackedUp();
        const stat = fs.statSync(tarFile);
        console.log(`[Backup] Created: ${tarFile} (${(stat.size / 1024).toFixed(1)} KB)`);
        return tarFile;
      } catch {
        throw new Error(`Failed to create backup. Neither zip nor tar available.`);
      }
    }

    const stat = fs.statSync(backupFile);
    if (stat.size === 0) {
      fs.unlinkSync(backupFile);
      throw new Error('Backup file is empty — budget data may be missing.');
    }

    this.sessionBackupPath = backupFile;
    client.markBackedUp();
    console.log(`[Backup] Created: ${backupFile} (${(stat.size / 1024).toFixed(1)} KB)`);
    return backupFile;
  }

  getSessionBackup(): string | null {
    return this.sessionBackupPath;
  }

  listBackups(): string[] {
    if (!fs.existsSync(this.backupDir)) return [];

    return fs.readdirSync(this.backupDir)
      .filter(f => f.startsWith('backup-') && (f.endsWith('.zip') || f.endsWith('.tar.gz')))
      .sort()
      .reverse();
  }

  cleanOldBackups(keepCount: number = 10): number {
    const backups = this.listBackups();
    if (backups.length <= keepCount) return 0;

    const toRemove = backups.slice(keepCount);
    for (const file of toRemove) {
      fs.unlinkSync(path.join(this.backupDir, file));
    }

    console.log(`[Backup] Cleaned ${toRemove.length} old backups, kept ${keepCount}`);
    return toRemove.length;
  }
}
