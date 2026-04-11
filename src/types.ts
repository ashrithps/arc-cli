// ── Configuration ──────────────────────────────────────────────

export interface RuntimeBudgetProfile {
  syncId?: string;
  budgetName?: string;
  isEncrypted?: boolean;
  hasSavedPassword?: boolean;
  encryptionPassword?: string;
}

export interface RuntimeConfig {
  apiUrl: string;
  apiKey: string;
  displayUrl?: string;
  defaultSyncId?: string;
  defaultBudgetName?: string;
  encryptionPassword?: string;
  budgets?: Record<string, RuntimeBudgetProfile>;
}

export interface InstallPayload {
  apiUrl: string;
  apiKey: string;
  syncId: string;
  displayUrl?: string;
  budgetName?: string;
  encryptionPassword?: string;
  generatedAt?: string;
  sourceApp?: string;
}

export interface ActualConfig {
  serverURL: string;
  password: string;
  budgetSyncId?: string;
  encryptionPassword?: string;
  explicitEncryptionPassword?: string;
  dataDir: string;
}

export interface BudgetFile {
  id?: string;
  cloudFileId: string;
  groupId: string;
  name: string;
  encryptKeyId?: string;
  hasKey?: boolean;
  owner?: string;
}

// ── Session State ─────────────────────────────────────────────

export interface SessionState {
  connected: boolean;
  backedUp: boolean;
  synced: boolean;
  budgetId: string | null;
  configuredAt: Date | null;
}

// ── Accounts ──────────────────────────────────────────────────

export interface Account {
  id: string;
  name: string;
  type?: string;
  offbudget?: boolean;
  closed?: boolean;
  balance_current?: number;
  balance_available?: number;
}

// ── Transactions ──────────────────────────────────────────────

export interface Transaction {
  id: string;
  account: string;
  date: string;
  amount: number;
  payee?: string;
  payee_name?: string;
  imported_payee?: string;
  category?: string;
  category_name?: string;
  notes?: string;
  imported_id?: string;
  transfer_id?: string;
  cleared?: boolean;
  reconciled?: boolean;
  is_parent?: boolean;
  is_child?: boolean;
  parent_id?: string;
  schedule?: string;
  subtransactions?: SubTransaction[];
  starting_balance_flag?: boolean;
  sort_order?: number;
  error?: any;
}

export interface SubTransaction {
  amount: number;
  category?: string;
  notes?: string;
  payee?: string;
  transfer_account?: string;  // Account name for transfer splits
}

export interface TransactionCreate {
  /**
   * Optional caller-supplied id. Actual respects this when present, which
   * lets us return a stable id from operations like addTransaction even
   * though @actual-app/api's `addTransactions` IPC returns "ok" instead
   * of the assigned ids.
   */
  id?: string;
  account?: string;
  date: string;
  amount?: number;
  payee_name?: string;
  payee?: string;
  category?: string;
  notes?: string;
  imported_id?: string;
  cleared?: boolean;
  imported_payee?: string;
  subtransactions?: SubTransaction[];
}

export interface ImportResult {
  errors: any[];
  added: number;
  updated: number;
}

// ── Categories ────────────────────────────────────────────────

export interface Category {
  id: string;
  name: string;
  group_id?: string;
  is_income?: boolean;
  hidden?: boolean;
}

export interface CategoryGroup {
  id: string;
  name: string;
  is_income?: boolean;
  hidden?: boolean;
  categories?: Category[];
}

export interface BudgetContext {
  requestedRef?: string;
  resolvedRef: string;
  name: string;
  groupId: string;
  cloudFileId: string;
  localId?: string;
}

export interface SwitchBudgetOptions {
  budgetRef: string;
  password?: string;
  isInteractive?: boolean;
  env?: NodeJS.ProcessEnv;
  promptForPassword?: (context: BudgetContext) => Promise<string>;
}

// ── Payees ────────────────────────────────────────────────────

export interface Payee {
  id: string;
  name: string;
  category?: string;
  transfer_acct?: string;
}

// ── Rules ─────────────────────────────────────────────────────

export interface RuleCondition {
  field: string;
  op: string;
  value: any;
  type?: string;
}

export interface RuleAction {
  field: string;
  op?: string;
  value: any;
  type?: string;
  options?: Record<string, any>;
}

export interface Rule {
  id: string;
  stage?: 'pre' | 'default' | 'post';
  conditionsOp?: 'and' | 'or';
  conditions: RuleCondition[];
  actions: RuleAction[];
}

// ── Schedules ─────────────────────────────────────────────────

export interface Schedule {
  id: string;
  name?: string;
  rule?: string;
  next_date?: string;
  completed?: boolean;
  posts_transaction?: boolean;
  tombstone?: boolean;
  date?: any;
  amount?: number;
  account?: string;
  payee?: string;
  category?: string;
  frequency?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  patterns?: any[];
  endMode?: 'never' | 'after_n_occurrences' | 'on_date';
  endOccurrences?: number;
  endDate?: string;
  skipWeekend?: 'before' | 'after' | false;
}

// ── Budget ────────────────────────────────────────────────────

export interface BudgetCategory {
  id: string;
  name: string;
  budgeted: number;
  spent: number;
  balance: number;
  carryover?: boolean;
  group_id?: string;
}

export interface BudgetCategoryGroup {
  id: string;
  name: string;
  budgeted: number;
  spent: number;
  balance: number;
  categories: BudgetCategory[];
}

export interface BudgetMonth {
  month: string;
  incomeAvailable?: number;
  lastMonthOverspent?: number;
  forNextMonth?: number;
  totalBudgeted?: number;
  toBudget?: number;
  categoryGroups: BudgetCategoryGroup[];
}

// ── Write Result ──────────────────────────────────────────────

export interface WriteResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  backupPath?: string;
}
