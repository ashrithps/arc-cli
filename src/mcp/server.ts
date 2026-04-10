/**
 * Arc MCP server.
 *
 * Every tool exposed here is driven by the public operation registry in
 * `src/public-surface/operation-registry.ts`. That registry is the single
 * source of truth for the MCP surface, documentation, and CLI parity guards.
 *
 * Wiring model
 * ────────────
 * - Input schemas: registry entries declare zod raw shapes with snake_case
 *   keys (e.g. `transfer_to`, `imported_id`, `foreign_amount`). The MCP SDK
 *   consumes these directly.
 * - Handlers: `OPERATION_HANDLERS` is a string-indexed map keyed by
 *   `op.mcpTool`. Each handler receives a `{ client, writer }` dependency
 *   bag plus the validated input object.
 * - snake_case → internal name translation happens EXCLUSIVELY inside each
 *   handler (or the tiny helpers at the bottom of this file). There is no
 *   second dispatch through the CLI flag parser — handlers call the
 *   `src/operations/*` modules directly.
 *
 * Testability
 * ───────────
 * `createMcpServer({ client, writer })` is the dependency-injected factory
 * used by tests. `startMcpServer()` is the production entry point that
 * resolves the real `ActualClient` + `SafeWriter` on each call.
 * `listRegisteredToolNames()` returns the tool names that would actually be
 * registered so tests can drift-guard against the registry without spinning
 * up stdio.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ActualClient } from '../client.js';
import { BackupManager } from '../backup.js';
import { SafeWriter } from '../safe-writer.js';
import { getBudgetPassword, persistBudgetCatalog } from '../credential-store.js';
import { PUBLIC_OPERATIONS } from '../public-surface/operation-registry.js';
import type { PublicOperation } from '../public-surface/registry-types.js';
import { amountToCents } from '../utils/format.js';
import { makeImportedId } from '../utils/imported-id.js';
import { normalizeRulePayload, normalizeSchedulePayload, isLikelyUuid } from '../operations/normalizers.js';
import * as accountOps from '../operations/accounts.js';
import * as transactionOps from '../operations/transactions.js';
import * as categoryOps from '../operations/categories.js';
import * as payeeOps from '../operations/payees.js';
import * as ruleOps from '../operations/rules.js';
import * as scheduleOps from '../operations/schedules.js';
import * as budgetOps from '../operations/budgets.js';
import * as queryOps from '../operations/queries.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Dependency bag threaded into every operation handler. */
export interface McpHandlerDeps {
  client: ActualClient;
  writer: SafeWriter;
}

/** An operation handler receives deps + validated MCP input and returns JSON-safe data. */
export type McpOperationHandler = (
  deps: McpHandlerDeps,
  input: Record<string, any>
) => Promise<unknown>;

// ── Helpers (the ONE place snake_case → internal name translation lives) ────

/**
 * Translate registry-level (dollars) amount to the cents integer the
 * operation modules expect. Mirrors the CLI dispatcher's `amountToCents`
 * conversion.
 */
const dollarsToCents = (n: number | undefined): number | undefined =>
  n == null ? undefined : amountToCents(n);

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function resolveCategoryIdFromName(
  client: ActualClient,
  nameOrId: string
): Promise<string> {
  return categoryOps.resolveCategoryId(client, nameOrId);
}

async function resolveOrCreatePayeeId(
  { client, writer }: McpHandlerDeps,
  nameOrId: string
): Promise<string> {
  const existing = await payeeOps.findPayeeByName(client, nameOrId);
  if (existing) return existing.id;
  // If the caller passed a uuid, just return it verbatim.
  if (isLikelyUuid(nameOrId)) return nameOrId;
  return payeeOps.createPayee(client, writer, nameOrId);
}

// ── Handler registry ────────────────────────────────────────────────────────

export const OPERATION_HANDLERS: Record<string, McpOperationHandler> = {
  // accounts ─────────────────────────────────────────────────────────────────
  arc_accounts_list: async ({ client }) => accountOps.listAccounts(client),
  arc_accounts_balance: async ({ client }, { account }) => {
    const id = await accountOps.resolveAccountId(client, account);
    const balance = await accountOps.getAccountBalance(client, id);
    return { accountId: id, balance };
  },
  arc_accounts_create: async ({ client, writer }, { name, type, offbudget, balance }) => {
    const initial = balance != null ? amountToCents(balance) : undefined;
    const id = await accountOps.createAccount(client, writer, name, type, offbudget, initial);
    return { id };
  },
  arc_accounts_update: async ({ client, writer }, { id, name, type, offbudget }) => {
    const accountId = await accountOps.resolveAccountId(client, id);
    const fields: Record<string, unknown> = {};
    if (name != null) fields.name = name;
    if (type != null) fields.type = type;
    if (offbudget != null) fields.offbudget = offbudget;
    await accountOps.updateAccount(client, writer, accountId, fields as any);
    return { id: accountId };
  },
  arc_accounts_close: async ({ client, writer }, { id, transfer_to }) => {
    const accountId = await accountOps.resolveAccountId(client, id);
    const transferId = transfer_to
      ? await accountOps.resolveAccountId(client, transfer_to)
      : undefined;
    await accountOps.closeAccount(client, writer, accountId, transferId);
    return { id: accountId };
  },
  arc_accounts_reopen: async ({ client, writer }, { id }) => {
    const accountId = await accountOps.resolveAccountId(client, id);
    await accountOps.reopenAccount(client, writer, accountId);
    return { id: accountId };
  },
  arc_accounts_delete: async ({ client, writer }, { id }) => {
    const accountId = await accountOps.resolveAccountId(client, id);
    await accountOps.deleteAccount(client, writer, accountId);
    return { id: accountId };
  },

  // transactions ─────────────────────────────────────────────────────────────
  arc_transactions_list: async ({ client }, { account, start, end }) => {
    const id = await accountOps.resolveAccountId(client, account);
    return transactionOps.listTransactions(client, id, start, end);
  },
  arc_transactions_add: async (deps, { account, date, amount, payee, category, notes, cleared, imported_id }) => {
    const { client, writer } = deps;
    const accountId = await accountOps.resolveAccountId(client, account);
    const amountCents = amountToCents(amount);
    const tx: Record<string, unknown> = { date, amount: amountCents };
    if (payee) tx.payee_name = payee;
    if (category) tx.category = await resolveCategoryIdFromName(client, category);
    if (notes) tx.notes = notes;
    tx.cleared = cleared ?? true;
    tx.imported_id = imported_id || makeImportedId([
      accountId,
      date,
      amountCents,
      (tx.payee_name as string) || '',
      (tx.notes as string) || '',
    ]);
    await transactionOps.importTransaction(client, writer, accountId, tx as any);
    return { ok: true };
  },
  arc_transactions_import: async ({ client, writer }, { account, data }) => {
    const accountId = await accountOps.resolveAccountId(client, account);
    const txs = JSON.parse(data);
    const result = await transactionOps.importTransactions(client, writer, accountId, txs);
    return result;
  },
  arc_transactions_update: async (deps, { id, amount, date, notes, cleared, category, payee }) => {
    const { client, writer } = deps;
    const fields: Record<string, unknown> = {};
    if (amount != null) fields.amount = amountToCents(amount);
    if (date != null) fields.date = date;
    if (notes != null) fields.notes = notes;
    if (cleared != null) fields.cleared = cleared;
    if (category != null) fields.category = await resolveCategoryIdFromName(client, category);
    if (payee != null) fields.payee = await resolveOrCreatePayeeId(deps, payee);
    await transactionOps.updateTransaction(client, writer, id, fields as any);
    return { id };
  },
  arc_transactions_delete: async ({ client, writer }, { id }) => {
    await transactionOps.deleteTransaction(client, writer, id);
    return { id };
  },
  arc_transactions_split: async ({ client, writer }, { account, date, payee, notes, cleared, subs }) => {
    const accountId = await accountOps.resolveAccountId(client, account);
    const parsed = JSON.parse(subs) as any[];
    const subsCents = await Promise.all(parsed.map(async (s: any) => {
      const next: any = { ...s, amount: amountToCents(s.amount) };
      if (s.category && !isLikelyUuid(s.category)) {
        const cat = await categoryOps.findCategoryByName(client, s.category);
        if (cat) next.category = cat.id;
      }
      return next;
    }));
    let parentPayeeId: string | undefined;
    if (payee) {
      const p = await payeeOps.findPayeeByName(client, payee);
      parentPayeeId = p?.id;
    }
    const id = await transactionOps.createSplitTransaction(client, writer, accountId, {
      date, payee_name: payee, payee: parentPayeeId, notes, cleared,
    }, subsCents);
    return { id };
  },
  arc_transactions_transfer: async ({ client, writer }, { from, to, amount, date, notes, cleared, foreign_amount }) => {
    const fromId = await accountOps.resolveAccountId(client, from);
    const toId = await accountOps.resolveAccountId(client, to);
    const id = await transactionOps.createTransfer(
      client,
      writer,
      fromId,
      toId,
      amountToCents(amount),
      date,
      notes,
      cleared ?? true,
      dollarsToCents(foreign_amount)
    );
    return { id };
  },
  arc_transactions_batch_update: async (deps, { data }) => {
    const { client, writer } = deps;
    const updates = JSON.parse(data) as any[];
    let count = 0;
    for (const upd of updates) {
      const fields: Record<string, unknown> = {};
      if (upd.amount != null) fields.amount = amountToCents(upd.amount);
      if (upd.date) fields.date = upd.date;
      if (upd.notes != null) fields.notes = upd.notes;
      if (upd.cleared != null) fields.cleared = upd.cleared;
      if (upd.category) fields.category = await resolveCategoryIdFromName(client, upd.category);
      if (upd.payee) fields.payee = await resolveOrCreatePayeeId(deps, upd.payee);
      if (Object.keys(fields).length > 0) {
        await transactionOps.updateTransaction(client, writer, upd.id, fields as any);
        count++;
      }
    }
    return { updated: count };
  },
  arc_transactions_batch_add: async ({ client, writer }, { account, data }) => {
    const accountId = await accountOps.resolveAccountId(client, account);
    const list = JSON.parse(data) as any[];
    const prepared: any[] = [];
    for (const t of list) {
      const tx: any = {
        date: t.date,
        amount: amountToCents(t.amount),
        cleared: t.cleared ?? true,
      };
      if (t.payee_name || t.payee) tx.payee_name = t.payee_name || t.payee;
      if (t.notes) tx.notes = t.notes;
      if (t.imported_id) tx.imported_id = t.imported_id;
      if (t.category) {
        if (isLikelyUuid(t.category)) {
          tx.category = t.category;
        } else {
          const cat = await categoryOps.findCategoryByName(client, t.category);
          if (cat) tx.category = cat.id;
        }
      }
      prepared.push(tx);
    }
    for (const tx of prepared) {
      tx.imported_id = tx.imported_id || makeImportedId([
        accountId, tx.date, tx.amount, tx.payee_name || '', tx.notes || '',
      ]);
    }
    const result = await transactionOps.importTransactions(client, writer, accountId, prepared);
    return result;
  },
  arc_transactions_batch_categorize: async ({ client, writer }, { account, payee, category, start, end }) => {
    const accountId = await accountOps.resolveAccountId(client, account);
    const cat = await categoryOps.findCategoryByName(client, category);
    if (!cat) throw new Error(`Category not found: ${category}`);
    const allTxns = await transactionOps.listTransactions(client, accountId, start, end);
    const pattern = String(payee).toLowerCase();
    const allPayees = await payeeOps.listPayees(client);
    const payeeMap: Record<string, string> = {};
    for (const p of allPayees) payeeMap[p.id] = p.name;
    const matches = allTxns.filter((t: any) => {
      if (t.category) return false;
      if (t.is_parent || t.is_child || t.transfer_id) return false;
      const pName = (t.payee_name || t.imported_payee || payeeMap[t.payee] || '').toLowerCase();
      return pName.includes(pattern);
    });
    let count = 0;
    for (const t of matches) {
      try {
        await transactionOps.updateTransaction(client, writer, (t as any).id, { category: cat.id } as any);
        count++;
      } catch { /* ignore individual failures */ }
    }
    return { matched: matches.length, updated: count };
  },

  // categories ───────────────────────────────────────────────────────────────
  arc_categories_list: async ({ client }) => categoryOps.listCategories(client),
  arc_categories_create: async ({ client, writer }, { name, group, income }) => {
    const groupId = await categoryOps.resolveCategoryGroupId(client, group);
    const id = await categoryOps.createCategory(client, writer, name, groupId, income);
    return { id };
  },
  arc_categories_update: async ({ client, writer }, { id, name, group, hidden }) => {
    const categoryId = await categoryOps.resolveCategoryId(client, id);
    const fields: Record<string, unknown> = {};
    if (name != null) fields.name = name;
    if (group != null) fields.group_id = await categoryOps.resolveCategoryGroupId(client, group);
    if (hidden != null) fields.hidden = hidden;
    await categoryOps.updateCategory(client, writer, categoryId, fields as any);
    return { id: categoryId };
  },
  arc_categories_delete: async ({ client, writer }, { id, transfer_to }) => {
    const categoryId = await categoryOps.resolveCategoryId(client, id);
    const transferId = transfer_to
      ? await categoryOps.resolveCategoryId(client, transfer_to)
      : undefined;
    await categoryOps.deleteCategory(client, writer, categoryId, transferId);
    return { id: categoryId };
  },

  // payees ───────────────────────────────────────────────────────────────────
  arc_payees_list: async ({ client }, { all }) => {
    const list = await payeeOps.listPayees(client);
    if (all) return list;
    return list.filter((p: any) => !p.transfer_acct);
  },
  arc_payees_create: async ({ client, writer }, { name }) => {
    const id = await payeeOps.createPayee(client, writer, name);
    return { id };
  },
  arc_payees_update: async ({ client, writer }, { id, name }) => {
    const payeeId = await payeeOps.resolvePayeeId(client, id);
    const fields: Record<string, unknown> = {};
    if (name != null) fields.name = name;
    await payeeOps.updatePayee(client, writer, payeeId, fields as any);
    return { id: payeeId };
  },
  arc_payees_delete: async ({ client, writer }, { id }) => {
    const payeeId = await payeeOps.resolvePayeeId(client, id);
    await payeeOps.deletePayee(client, writer, payeeId);
    return { id: payeeId };
  },
  arc_payees_merge: async ({ client, writer }, { target, merge }) => {
    const targetId = await payeeOps.resolvePayeeId(client, target);
    const rawIds = String(merge).split(',').map((s: string) => s.trim()).filter(Boolean);
    const mergeIds = await Promise.all(rawIds.map((r: string) => payeeOps.resolvePayeeId(client, r)));
    await payeeOps.mergePayees(client, writer, targetId, mergeIds);
    return { target: targetId, merged: mergeIds.length };
  },
  arc_payees_find_or_create: async ({ client, writer }, { name }) => {
    const id = await payeeOps.findOrCreatePayee(client, writer, name);
    return { id };
  },
  arc_payees_common: async ({ client }, { limit }) => {
    return payeeOps.getCommonPayees(client, limit);
  },

  // rules ────────────────────────────────────────────────────────────────────
  arc_rules_list: async ({ client }) => ruleOps.listRules(client),
  arc_rules_create: async ({ client, writer }, { data }) => {
    const payload = await normalizeRulePayload(client, JSON.parse(data));
    const id = await ruleOps.createRule(client, writer, payload);
    return { id };
  },
  arc_rules_update: async ({ client, writer }, { data }) => {
    const payload = await normalizeRulePayload(client, JSON.parse(data));
    const updated = await ruleOps.updateRule(client, writer, payload);
    return { id: updated.id };
  },
  arc_rules_delete: async ({ client, writer }, { id }) => {
    await ruleOps.deleteRule(client, writer, id);
    return { id };
  },

  // schedules ────────────────────────────────────────────────────────────────
  arc_schedules_list: async ({ client }) => scheduleOps.listSchedules(client),
  arc_schedules_create: async ({ client, writer }, { data }) => {
    const payload = await normalizeSchedulePayload(client, JSON.parse(data));
    const id = await scheduleOps.createSchedule(client, writer, payload);
    return { id };
  },
  arc_schedules_update: async ({ client, writer }, { id, data }) => {
    const payload = await normalizeSchedulePayload(client, JSON.parse(data));
    await scheduleOps.updateSchedule(client, writer, id, payload);
    return { id };
  },
  arc_schedules_delete: async ({ client, writer }, { id }) => {
    await scheduleOps.deleteSchedule(client, writer, id);
    return { id };
  },
  arc_schedules_post: async ({ client, writer }, { id, date }) => {
    const txnId = await scheduleOps.postSchedule(client, writer, id, date);
    return { transactionId: txnId };
  },
  arc_schedules_upcoming: async ({ client }) => scheduleOps.getUpcomingSchedules(client),
  arc_schedules_complete: async ({ client, writer }, { id }) => {
    await scheduleOps.completeSchedule(client, writer, id);
    return { id };
  },

  // budgets ──────────────────────────────────────────────────────────────────
  arc_budgets_list: async ({ client }) => {
    // List budgets does NOT require an open session; callers must still pass
    // a live client but we only use it for server config.
    const files = await client.listBudgets();
    persistBudgetCatalog(files);
    return files.map(file => ({
      syncId: file.groupId,
      cloudFileId: file.cloudFileId,
      name: file.name,
      isEncrypted: !!file.encryptKeyId,
      hasSavedPassword: !!getBudgetPassword(file.groupId),
    }));
  },
  arc_budgets_months: async ({ client }) => budgetOps.getBudgetMonths(client),
  arc_budgets_month: async ({ client }, { month }) => budgetOps.getBudgetMonth(client, month),
  arc_budgets_set_amount: async ({ client, writer }, { month, category, amount }) => {
    const categoryId = await categoryOps.resolveCategoryId(client, category);
    await budgetOps.setBudgetAmount(client, writer, month, categoryId, amountToCents(amount));
    return { month, categoryId };
  },
  arc_budgets_set_carryover: async ({ client, writer }, { month, category, enabled }) => {
    const categoryId = await categoryOps.resolveCategoryId(client, category);
    await budgetOps.setBudgetCarryover(client, writer, month, categoryId, enabled);
    return { month, categoryId, enabled };
  },
  arc_budgets_transfer: async ({ client, writer }, { month, from, to, amount }) => {
    const fromId = await categoryOps.resolveCategoryId(client, from);
    const toId = await categoryOps.resolveCategoryId(client, to);
    await budgetOps.transferBudget(client, writer, month, fromId, toId, amountToCents(amount));
    return { month, from: fromId, to: toId };
  },
  arc_budgets_income: async ({ client }, { month }) => budgetOps.getIncomeForMonth(client, month),
  arc_budgets_summary: async ({ client }, { month }) => budgetOps.getTotalBudgeted(client, month),
  arc_budgets_switch: async ({ client }, { budget, password }) => {
    const context = await client.switchBudget({
      budgetRef: budget,
      password,
      isInteractive: false,
    });
    return {
      syncId: context.groupId,
      cloudFileId: context.cloudFileId,
      name: context.name,
    };
  },

  // query / report ───────────────────────────────────────────────────────────
  arc_query_spending: async ({ client }, { month }) => queryOps.getSpendingSummary(client, month),
  arc_query_accounts: async ({ client }) => queryOps.getAccountSummary(client),
  arc_query_uncategorized: async ({ client }, { account }) => {
    let accountId: string | undefined;
    if (account) accountId = await accountOps.resolveAccountId(client, account);
    return queryOps.getUncategorizedTransactions(client, accountId);
  },
  arc_query_payee: async ({ client }, { name, limit }) =>
    queryOps.getTransactionsByPayee(client, name, limit),
  arc_query_category: async ({ client }, { name, start, end }) =>
    queryOps.getTransactionsByCategory(client, name, start, end),
  arc_query_trends: async ({ client }, { months }) => queryOps.getSpendingTrends(client, months),
  arc_query_top: async ({ client }, { month, limit }) =>
    queryOps.getTopCategories(client, month, limit),
  arc_query_monthly: async ({ client }, { months }) => queryOps.getMonthlyTotals(client, months),
  arc_query_balance_history: async ({ client }, { account, months }) => {
    const id = await accountOps.resolveAccountId(client, account);
    return queryOps.getBalanceHistory(client, id, months);
  },
  arc_query_monthly_balances: async ({ client }, { account, months }) => {
    const id = await accountOps.resolveAccountId(client, account);
    return queryOps.getMonthlyBalances(client, id, months);
  },
  arc_query_custom: async ({ client }, { q }) => queryOps.runCustomQuery(client, JSON.parse(q)),
};

// ── Introspection ───────────────────────────────────────────────────────────

/**
 * Return the tool names that would be registered by `createMcpServer`.
 * This is the intersection of the public operation registry and the
 * handlers currently wired in `OPERATION_HANDLERS`, so tests can use it as
 * a drift guard.
 */
export async function listRegisteredToolNames(): Promise<string[]> {
  return PUBLIC_OPERATIONS
    .filter(op => op.mcpTool in OPERATION_HANDLERS)
    .map(op => op.mcpTool);
}

/** The operations that will be registered, paired with their handlers. */
export function enumerateRegisteredOperations(): Array<{
  op: PublicOperation;
  handler: McpOperationHandler;
}> {
  const result: Array<{ op: PublicOperation; handler: McpOperationHandler }> = [];
  for (const op of PUBLIC_OPERATIONS) {
    const handler = OPERATION_HANDLERS[op.mcpTool];
    if (!handler) continue;
    result.push({ op, handler });
  }
  return result;
}

// ── Server factory ──────────────────────────────────────────────────────────

export interface CreateMcpServerOptions {
  /** Dep-injection hook used by tests. */
  client?: ActualClient;
  writer?: SafeWriter;
  /**
   * Optional override for resolving `{ client, writer }` per tool invocation.
   * When absent, production mode (`startMcpServer`) wires a fresh connected
   * client + SafeWriter using `withRealClient`.
   */
  resolveDeps?: () => Promise<{
    deps: McpHandlerDeps;
    cleanup: () => Promise<void>;
  }>;
}

/** Build an MCP server whose tools are driven by the public operation registry. */
export function createMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'arc', version: '1.0.0' });

  const { client: injectedClient, writer: injectedWriter, resolveDeps } = options;

  const resolve = async (): Promise<{
    deps: McpHandlerDeps;
    cleanup: () => Promise<void>;
  }> => {
    if (resolveDeps) return resolveDeps();
    if (injectedClient && injectedWriter) {
      return {
        deps: { client: injectedClient, writer: injectedWriter },
        cleanup: async () => { /* no-op: caller owns lifecycle */ },
      };
    }
    return withRealClient();
  };

  for (const { op, handler } of enumerateRegisteredOperations()) {
    server.registerTool(
      op.mcpTool,
      {
        description: op.description,
        inputSchema: op.inputSchema,
      },
      async (input: Record<string, any>) => {
        const { deps, cleanup } = await resolve();
        try {
          const result = await handler(deps, input ?? {});
          return { content: [{ type: 'text', text: jsonText(result) }] };
        } finally {
          await cleanup();
        }
      }
    );
  }

  return server;
}

/**
 * Production dep resolver: opens a fresh connected `ActualClient` + a
 * `SafeWriter` backed by the default `BackupManager`, then disconnects when
 * the handler returns.
 */
async function withRealClient(): Promise<{
  deps: McpHandlerDeps;
  cleanup: () => Promise<void>;
}> {
  const client = ActualClient.fromEnv();
  await client.connect();
  const backup = new BackupManager();
  const writer = new SafeWriter(client, backup);
  return {
    deps: { client, writer },
    cleanup: async () => {
      try {
        await client.disconnect();
      } catch {
        try { await client.api.shutdown(); } catch { /* best effort */ }
      }
    },
  };
}

// ── Production entry point ──────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
