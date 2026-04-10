import './utils/actual-console.js';
import * as actualApi from '@actual-app/api';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'node:readline';
import { getArcDataDir } from './runtime-paths.js';
import { loadRuntimeConfig } from './config-store.js';
import {
  getBudgetPassword,
  persistBudgetCatalog,
  persistSelectedBudget,
  saveBudgetPassword,
} from './credential-store.js';
import type { ActualConfig, BudgetContext, BudgetFile, SessionState, SwitchBudgetOptions } from './types.js';

export class ActualClient {
  private config: ActualConfig;
  private state: SessionState;
  private sessionDataDir: string | null = null;
  private localBudgetId: string | null = null;
  private budgetContext: BudgetContext | null = null;
  private pendingBudgetPassword?: string;
  private explicitBudgetPassword?: string;

  constructor(config: ActualConfig) {
    this.config = config;
    this.pendingBudgetPassword = config.encryptionPassword;
    this.explicitBudgetPassword = config.explicitEncryptionPassword;
    this.state = {
      connected: false,
      backedUp: false,
      synced: false,
      budgetId: null,
      configuredAt: null,
    };
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ActualClient {
    const runtime = loadRuntimeConfig(env);
    const serverURL = runtime.apiUrl;
    const password = runtime.apiKey;
    const budgetSyncId = runtime.defaultSyncId;
    const explicitEncryptionPassword = env.ACTUAL_ENCRYPTION_PASSWORD;
    const encryptionPassword = budgetSyncId
      ? runtime.budgets?.[budgetSyncId]?.encryptionPassword ?? runtime.encryptionPassword
      : runtime.encryptionPassword;
    const dataDir = env.ACTUAL_DATA_DIR || getArcDataDir(env);

    if (!serverURL) throw new Error('ACTUAL_SERVER_URL is required in .env');
    if (!password) throw new Error('ACTUAL_PASSWORD is required in .env');

    return new ActualClient({
      serverURL,
      password,
      budgetSyncId,
      encryptionPassword,
      explicitEncryptionPassword,
      dataDir,
    });
  }

  private initialized = false;
  private readonly transientErrorPatterns = [
    /fetch failed/i,
    /download-failure/i,
    /could not get remote files/i,
    /network/i,
    /timed?\s*out/i,
    /econnreset/i,
    /enotfound/i,
    /eai_again/i,
    /socket hang up/i,
    /internal$/i,
  ];

  private getEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private get connectAttempts(): number {
    return this.getEnvInt('ARCTUAL_CONNECT_RETRIES', 5);
  }

  private get syncAttempts(): number {
    return this.getEnvInt('ARCTUAL_SYNC_RETRIES', 5);
  }

  private get retryBaseDelayMs(): number {
    return this.getEnvInt('ARCTUAL_RETRY_BASE_DELAY_MS', 1500);
  }

  private getBaseDataDir(): string {
    return path.resolve(this.config.dataDir);
  }

  private ensureBaseDataDir(): void {
    fs.mkdirSync(this.getBaseDataDir(), { recursive: true });
  }

  private ensureSessionDataDir(): string {
    if (this.sessionDataDir) return this.sessionDataDir;

    this.ensureBaseDataDir();
    const sessionsDir = path.join(this.getBaseDataDir(), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const sessionId = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    this.sessionDataDir = path.join(sessionsDir, sessionId);
    fs.mkdirSync(this.sessionDataDir, { recursive: true });
    return this.sessionDataDir;
  }

  private async resetSession(): Promise<void> {
    try {
      await actualApi.shutdown();
    } catch {
      // Best effort shutdown before discarding the session cache
    }

    if (this.sessionDataDir && fs.existsSync(this.sessionDataDir)) {
      fs.rmSync(this.sessionDataDir, { recursive: true, force: true });
    }

    this.initialized = false;
    this.state.connected = false;
    this.state.synced = false;
    this.sessionDataDir = null;
    this.localBudgetId = null;
  }

  private async resolveLocalBudgetId(syncId: string): Promise<string | null> {
    const budgets = await this.listBudgets();
    const local = budgets.find((budget: any) =>
      budget.id &&
      (budget.id === syncId || budget.groupId === syncId || budget.cloudFileId === syncId)
    );
    return local?.id || null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isTransientActualError(error: unknown): boolean {
    const message = this.formatError(error);
    return this.transientErrorPatterns.some(pattern => pattern.test(message));
  }

  private async retry<T>(
    label: string,
    fn: () => Promise<T>,
    options: {
      attempts?: number;
      baseDelayMs?: number;
      shouldRetry?: (error: unknown, attempt: number) => boolean;
      beforeRetry?: (error: unknown, attempt: number) => Promise<void> | void;
    } = {}
  ): Promise<T> {
    const {
      attempts = 3,
      baseDelayMs = 500,
      shouldRetry = () => true,
      beforeRetry,
    } = options;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === attempts || !shouldRetry(error, attempt)) break;
        await beforeRetry?.(error, attempt);
        await this.sleep(baseDelayMs * attempt);
      }
    }

    throw new Error(`${label} failed after ${attempts} attempts: ${this.formatError(lastError)}`);
  }

  private async downloadAndLoadBudget(): Promise<void> {
    const downloadOpts: any = { password: this.config.encryptionPassword };
    await this.retry(
      'Budget download',
      () => actualApi.downloadBudget(this.config.budgetSyncId!, downloadOpts),
      {
        attempts: 4,
        baseDelayMs: this.retryBaseDelayMs,
        shouldRetry: error => this.isTransientActualError(error),
      }
    );

    this.localBudgetId = await this.resolveLocalBudgetId(this.config.budgetSyncId!);
    if (this.localBudgetId) {
      await actualApi.loadBudget(this.localBudgetId);
    }
  }

  private async restoreConnectedSession(): Promise<void> {
    await this.resetSession();
    await this.init();
    await this.downloadAndLoadBudget();
    this.state.connected = true;
    this.state.budgetId = this.config.budgetSyncId!;
    this.state.configuredAt ??= new Date();
  }

  private async syncWithRecovery(
    label: string,
    options: {
      attempts?: number;
      rebuildSessionOnRetry?: boolean;
      allowFailure?: boolean;
    } = {}
  ): Promise<void> {
    const {
      attempts = 4,
      rebuildSessionOnRetry = false,
      allowFailure = false,
    } = options;

    try {
      await this.retry(
        label,
        () => actualApi.sync(),
        {
          attempts,
          baseDelayMs: this.retryBaseDelayMs,
          shouldRetry: error => this.isTransientActualError(error),
          beforeRetry: async () => {
            if (rebuildSessionOnRetry) {
              await this.restoreConnectedSession();
            }
          },
        }
      );
      this.state.synced = true;
    } catch (error) {
      this.state.synced = false;
      if (!allowFailure) {
        throw error;
      }
    }
  }

  /**
   * Initialize the API connection (auth only, no budget loaded).
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    const sessionDataDir = this.ensureSessionDataDir();
    await actualApi.init({
      serverURL: this.config.serverURL,
      password: this.config.password,
      dataDir: sessionDataDir,
    });
    this.initialized = true;
  }

  /**
   * List all available budget files on the server.
   */
  async listBudgets(): Promise<BudgetFile[]> {
    return await (actualApi as any).getBudgets();
  }

  /**
   * Select a budget by sync ID or by index from the list.
   */
  selectBudget(budgetRef: string): void {
    this.config.budgetSyncId = budgetRef;
    this.budgetContext = null;
    this.pendingBudgetPassword = undefined;
  }

  setEncryptionPassword(password?: string): void {
    this.config.encryptionPassword = password;
    this.pendingBudgetPassword = password;
  }

  private async resolveBudgetReference(ref: string): Promise<BudgetFile | null> {
    const budgets = await this.listBudgets();
    return budgets.find((budget: any) =>
      budget.groupId === ref ||
      budget.cloudFileId === ref ||
      budget.id === ref ||
      budget.name === ref
    ) || null;
  }

  async resolveBudgetContext(ref?: string): Promise<BudgetContext | null> {
    const requestedRef = ref || this.config.budgetSyncId;
    if (!requestedRef) return null;
    const matched = await this.resolveBudgetReference(requestedRef);
    if (!matched) {
      throw new Error(`Budget not found: ${requestedRef}`);
    }
    return {
      requestedRef,
      resolvedRef: matched.groupId,
      name: matched.name,
      groupId: matched.groupId,
      cloudFileId: matched.cloudFileId,
      localId: matched.id,
    };
  }

  private async normalizeBudgetSelection(): Promise<void> {
    if (!this.config.budgetSyncId) return;
    const context = await this.resolveBudgetContext(this.config.budgetSyncId);
    if (!context) return;
    this.budgetContext = context;
    this.config.budgetSyncId = context.groupId;
  }

  private applySelectedBudgetPassword(env: NodeJS.ProcessEnv = process.env): void {
    const selectedSyncId = this.budgetContext?.groupId ?? this.config.budgetSyncId;
    if (!selectedSyncId) {
      this.config.encryptionPassword = this.pendingBudgetPassword;
      return;
    }

    const storedPassword = getBudgetPassword(selectedSyncId, env);
    this.config.encryptionPassword =
      storedPassword ?? this.pendingBudgetPassword ?? this.explicitBudgetPassword;
    this.pendingBudgetPassword = undefined;
  }

  /**
   * Connect to a specific budget. If no budgetSyncId is set,
   * lists available budgets and picks the first (or only) one.
   */
  async connect(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    if (this.state.connected) return;

    await this.init();

    // If no budget specified, auto-select
    if (!this.config.budgetSyncId) {
      const budgets = await this.listBudgets();

      if (budgets.length === 0) {
        throw new Error('No budget files found on this server.');
      }

      if (budgets.length === 1) {
        this.config.budgetSyncId = budgets[0].groupId;
        this.budgetContext = {
          requestedRef: budgets[0].groupId,
          resolvedRef: budgets[0].groupId,
          name: budgets[0].name,
          groupId: budgets[0].groupId,
          cloudFileId: budgets[0].cloudFileId,
          localId: budgets[0].id,
        };
        console.error(`[Client] Auto-selected budget: "${budgets[0].name}" (${budgets[0].groupId})`);
      } else {
        // List budgets for user/Claude to pick
        console.log(`[Client] Multiple budgets found. Use --budget=<id> or set ACTUAL_BUDGET_SYNC_ID:\n`);
        budgets.forEach((b, i) => {
          const enc = b.encryptKeyId ? ' [encrypted]' : '';
          console.log(`  ${i + 1}. ${b.name} (groupId: ${b.groupId}, cloudFileId: ${b.cloudFileId})${enc}`);
        });
        console.log('');
        throw new Error(
          `Multiple budgets available. Specify one with --budget=<id> or ACTUAL_BUDGET_SYNC_ID in .env. ` +
          `IDs: ${budgets.map(b => b.groupId).join(', ')}`
        );
      }
    } else {
      await this.normalizeBudgetSelection();
    }

    this.applySelectedBudgetPassword(env);

    try {
      await this.retry(
        'Connect budget session',
        () => this.downloadAndLoadBudget(),
        {
          attempts: this.connectAttempts,
          baseDelayMs: this.retryBaseDelayMs,
          shouldRetry: error => this.isTransientActualError(error),
          beforeRetry: async () => {
            await this.resetSession();
            await this.init();
          },
        }
      );
    } catch {
      throw new Error('Failed to load budget. Check server URL and budget ID.');
    }

    await this.syncWithRecovery('Initial sync', {
      attempts: this.syncAttempts,
      rebuildSessionOnRetry: true,
      allowFailure: true,
    });

    this.state.connected = true;
    this.state.budgetId = this.config.budgetSyncId!;
    this.state.configuredAt = new Date();

    console.error(`[Client] Connected to budget: ${this.config.budgetSyncId}`);
  }

  private async promptForBudgetPassword(context: BudgetContext): Promise<string> {
    const rl = createMaskedInterface(process.stdin, process.stdout);

    try {
      const answer = await new Promise<string>((resolve, reject) => {
        rl.question(`Encryption password for "${context.name}": `, resolve);
        rl.once('error', reject);
      });
      rl.output.write('\n');
      const password = answer.trim();
      if (!password) {
        throw new Error(`Password required for encrypted budget "${context.name}".`);
      }
      return password;
    } finally {
      rl.close();
    }
  }

  async switchBudget(options: SwitchBudgetOptions): Promise<BudgetContext> {
    const env = options.env ?? process.env;
    await this.init();

    const budgetFiles = await this.listBudgets();
    persistBudgetCatalog(budgetFiles, env);

    const target = await this.resolveBudgetContext(options.budgetRef);
    if (!target) {
      throw new Error(`Budget not found: ${options.budgetRef}`);
    }

    const file = budgetFiles.find(b => b.groupId === target.groupId || b.cloudFileId === target.groupId);
    const isEncrypted = !!file?.encryptKeyId;

    let budgetPassword = options.password ?? getBudgetPassword(target.groupId, env);
    if (isEncrypted && !budgetPassword) {
      if (!options.isInteractive) {
        throw new Error(
          `Password required for encrypted budget "${target.name}". Re-run with --password or use an interactive terminal.`
        );
      }

      const prompt = options.promptForPassword ?? (context => this.promptForBudgetPassword(context));
      budgetPassword = await prompt(target);
    }

    const previousConfig = this.getConfig();
    const wasConnected = this.getState().connected;

    if (wasConnected) {
      await this.disconnect();
    }

    this.selectBudget(target.groupId);
    this.setEncryptionPassword(budgetPassword);

    try {
      await this.connect(env);
    } catch (error) {
      this.config = previousConfig;
      throw error;
    }

    const profile = {
      syncId: target.groupId,
      budgetName: target.name,
      isEncrypted,
      hasSavedPassword: !!budgetPassword,
      encryptionPassword: budgetPassword,
    };

    if (budgetPassword) {
      saveBudgetPassword(profile, budgetPassword, env);
    }
    persistSelectedBudget(profile, env);

    return target;
  }

  async disconnect(): Promise<void> {
    if (!this.initialized) return;

    await this.syncWithRecovery('Disconnect sync', {
      attempts: Math.max(2, Math.min(this.syncAttempts, 3)),
      rebuildSessionOnRetry: false,
      allowFailure: true,
    });

    await actualApi.shutdown();

    if (this.sessionDataDir && fs.existsSync(this.sessionDataDir)) {
      fs.rmSync(this.sessionDataDir, { recursive: true, force: true });
    }

    this.state.connected = false;
    this.state.synced = false;
    this.sessionDataDir = null;
    this.localBudgetId = null;
    this.initialized = false;
    console.error('[Client] Disconnected');
  }

  async sync(options?: { attempts?: number; rebuildSessionOnRetry?: boolean; allowFailure?: boolean }): Promise<void> {
    this.ensureConnected();
    await this.syncWithRecovery('Sync', options);
  }

  ensureConnected(): void {
    if (!this.state.connected) {
      throw new Error('Not connected. Call connect() first.');
    }
  }

  getState(): SessionState {
    return { ...this.state };
  }

  getConfig(): ActualConfig {
    return { ...this.config };
  }

  getBudgetContext(): BudgetContext | null {
    return this.budgetContext;
  }

  getBudgetDataDir(): string | null {
    if (!this.sessionDataDir || !this.localBudgetId) return null;
    return path.join(this.sessionDataDir, this.localBudgetId);
  }

  getLockPath(): string {
    return path.join(this.getBaseDataDir(), '.write.lock');
  }

  async acquireWriteLock(operation: string, timeoutMs: number = 30000): Promise<() => void> {
    this.ensureBaseDataDir();
    const lockPath = this.getLockPath();
    const start = Date.now();

    while (true) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(fd, JSON.stringify({
          pid: process.pid,
          operation,
          createdAt: new Date().toISOString(),
        }));
        return () => {
          try {
            fs.closeSync(fd);
          } catch {}
          try {
            fs.unlinkSync(lockPath);
          } catch {}
        };
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;

        try {
          const stat = fs.statSync(lockPath);
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs > 10 * 60 * 1000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue;
        }

        if (Date.now() - start >= timeoutMs) {
          throw new Error('Timed out waiting for the Actual write lock. Another write session is still active.');
        }

        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  }

  async prepareForWrite(): Promise<void> {
    this.ensureConnected();
    await this.syncWithRecovery('Pre-write sync', {
      attempts: this.syncAttempts,
      rebuildSessionOnRetry: true,
      allowFailure: false,
    });
  }

  markBackedUp(): void {
    this.state.backedUp = true;
  }

  get api() {
    return actualApi;
  }
}

type MaskableInterface = readline.Interface & {
  _writeToOutput?: (chunk: string) => void;
  stdoutMuted?: boolean;
};

export function maskReadlineOutput(rl: MaskableInterface): void {
  const defaultWriteToOutput = rl._writeToOutput?.bind(rl);
  rl.stdoutMuted = true;
  rl._writeToOutput = (chunk: string) => {
    if (!rl.stdoutMuted) {
      defaultWriteToOutput?.(chunk);
      return;
    }
    if (chunk.includes('\n')) {
      rl.output.write(chunk);
    }
  };
}

export function createMaskedInterface(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): readline.Interface {
  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
  }) as MaskableInterface;

  maskReadlineOutput(rl);
  return rl;
}
