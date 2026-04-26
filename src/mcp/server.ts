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
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
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
import * as tagOps from '../operations/tags.js';

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
  arc_transactions_list: async ({ client }, { account, start, end, tag }) => {
    // `tag` filter searches across ALL accounts; `account` becomes optional
    // and narrows the result set when also supplied.
    if (tag) {
      const tagNames = String(tag).split(',').map((s: string) => s.trim().replace(/^#/, '')).filter(Boolean);
      let txns = await tagOps.listTransactionsByTags(client, tagNames, start, end);
      if (account) {
        const accountId = await accountOps.resolveAccountId(client, account);
        txns = txns.filter((t: any) => t.account === accountId);
      }
      return txns;
    }
    if (!account) throw new Error('--account is required when --tag is not provided.');
    const id = await accountOps.resolveAccountId(client, account);
    return transactionOps.listTransactions(client, id, start, end);
  },
  arc_transactions_add: async (deps, { account, date, amount, payee, category, notes, cleared, imported_id, tag }) => {
    const { client, writer } = deps;
    const accountId = await accountOps.resolveAccountId(client, account);
    const amountCents = amountToCents(amount);
    const tx: Record<string, unknown> = { date, amount: amountCents };
    if (payee) tx.payee_name = payee;
    if (category) tx.category = await resolveCategoryIdFromName(client, category);
    if (notes) tx.notes = notes;
    if (tag) {
      const tagNames = String(tag).split(',').map((s: string) => s.trim().replace(/^#/, '')).filter(Boolean);
      await tagOps.ensureTagsExist(client, writer, tagNames);
      let composed = (tx.notes as string) ?? '';
      for (const name of tagNames) composed = tagOps.addTagToken(composed, name);
      tx.notes = composed;
    }
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
  arc_transactions_update: async (deps, args) => {
    const { client, writer } = deps;
    const { id, amount, date, notes, cleared, category, payee } = args;
    const addTag = (args as any)['add-tag'];
    const removeTag = (args as any)['remove-tag'];
    const fields: Record<string, unknown> = {};
    if (amount != null) fields.amount = amountToCents(amount);
    if (date != null) fields.date = date;
    if (notes != null) fields.notes = notes;
    if (cleared != null) fields.cleared = cleared;
    if (category != null) fields.category = await resolveCategoryIdFromName(client, category);
    if (payee != null) fields.payee = await resolveOrCreatePayeeId(deps, payee);
    await transactionOps.updateTransaction(client, writer, id, fields as any);
    if (addTag) {
      const adds = String(addTag).split(',').map((s: string) => s.trim().replace(/^#/, '')).filter(Boolean);
      await tagOps.addTagsToTransaction(client, writer, id, adds);
    }
    if (removeTag) {
      const removes = String(removeTag).split(',').map((s: string) => s.trim().replace(/^#/, '')).filter(Boolean);
      await tagOps.removeTagsFromTransaction(client, writer, id, removes);
    }
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

  // tags ─────────────────────────────────────────────────────────────────────
  arc_tags_list: async ({ client }) => tagOps.listTags(client),
  arc_tags_add: async ({ client, writer }, { name, color, description }) => {
    const tag = await tagOps.createTag(client, writer, {
      tag: String(name).replace(/^#/, ''),
      color,
      description,
    });
    return tag;
  },
  arc_tags_update: async ({ client, writer }, { id, name, color, description }) => {
    const tagId = await tagOps.resolveTagId(client, id);
    const fields: Record<string, unknown> = {};
    if (name != null) fields.tag = String(name).replace(/^#/, '');
    if (color !== undefined) fields.color = color;
    if (description !== undefined) fields.description = description;
    await tagOps.updateTag(client, writer, tagId, fields as any);
    return { id: tagId };
  },
  arc_tags_delete: async ({ client, writer }, { id }) => {
    const tagId = await tagOps.resolveTagId(client, id);
    await tagOps.deleteTag(client, writer, tagId);
    return { id: tagId };
  },
  arc_tags_apply: async ({ client, writer }, { transaction, tag }) => {
    const tagNames = String(tag).split(',').map((s: string) => s.trim().replace(/^#/, '')).filter(Boolean);
    await tagOps.addTagsToTransaction(client, writer, String(transaction), tagNames);
    return { transaction, applied: tagNames };
  },
  arc_tags_unapply: async ({ client, writer }, { transaction, tag }) => {
    const tagNames = String(tag).split(',').map((s: string) => s.trim().replace(/^#/, '')).filter(Boolean);
    await tagOps.removeTagsFromTransaction(client, writer, String(transaction), tagNames);
    return { transaction, removed: tagNames };
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

/**
 * Groups whose tool results include integer-minor-unit amount fields.
 * Tools in these groups get a compact formatting reminder appended to
 * their description at registration time.
 */
const AMOUNT_BEARING_GROUPS = new Set<PublicOperation['group']>([
  'accounts',
  'transactions',
  'budgets',
  'query',
]);

const AMOUNT_REMINDER =
  '\n\nAmounts in the response are integer minor units (divide by 100 to get the decimal value, e.g. 37936 → 379.36). Render without any currency symbol unless the user has told you what currency they use.';

function decorateDescription(op: PublicOperation): string {
  if (!AMOUNT_BEARING_GROUPS.has(op.group)) return op.description;
  return `${op.description}${AMOUNT_REMINDER}`;
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

/**
 * Agent playbook injected into the MCP `initialize` response as
 * server-level instructions. Any MCP client that reads the `instructions`
 * field (Claude Desktop, Cursor's MCP client, etc.) gets this as durable
 * system-level guidance for every conversation — the skill file is NOT
 * loaded by those clients, so this is the only channel they have for
 * learning Arc's conventions.
 *
 * Keep this short enough that a small context-budget client is not
 * overwhelmed, but complete enough that agents stop:
 *   - reaching for `arc_budgets_*` when a query tool is the right answer,
 *   - rendering numbers without dividing by 100,
 *   - inventing currency symbols.
 */
const MCP_INSTRUCTIONS = `Arc exposes Actual Budget as a set of read/write tools. When you answer a
user question with these tools, follow these rules:

AMOUNTS AND CURRENCY
- Every amount field returned by any arc_* tool (spent, budgeted, balance,
  amount, income, expenses, net, etc.) is an INTEGER in MINOR UNITS.
  To convert to a human-readable value you MUST divide by 100 and show
  two decimal places. Example: 37936 means 379.36; -2017298 means
  -20172.98; 8989 means 89.89.
- Actual Budget is currency-agnostic. You do NOT know the user's currency.
  NEVER emit any currency symbol (no ₹, no $, no €, no £, no USD/INR/EUR
  prefixes, nothing). Return plain decimal numbers like "379.36" or
  "-20,172.98". If the user has explicitly told you their currency in
  this conversation, you may use that symbol; otherwise stay neutral.
- Never speculate about which minor unit the integer represents (cents,
  paise, pence, etc.). Just divide by 100 and present the decimal.

FOREIGN-CURRENCY ACCOUNTS (FX)

Some accounts hold balances in a currency different from the budget's
base currency. Users set this up via Actual rules that auto-convert
incoming amounts and prepend a marker to the notes. arc detects these
rules and surfaces the data on every read tool that returns accounts or
transactions:

- arc_accounts_list / arc_query_accounts: each row may include
    currency:      ISO-4217 code of the account's native currency
    fxRate:        the multiplier the rule applies (native → base)
    nativeBalance: the recovered balance in the account's native currency
                   minor units (still divide by 100 for display).
  When these are present, the account is denominated in that currency.
  Display the nativeBalance with the currency code (e.g. "1,543.27 INR")
  rather than the base-currency balance — that's what the user sees in
  their banking app.

- arc_transactions_list: each row may include a "native" object with
    amount:     native-currency minor units for this transaction
    currency:   ISO-4217 code
    rate:       FX rate that was applied
    cleanNotes: notes with the FX prefix stripped
  Use native.amount for display (divide by 100), and use cleanNotes
  instead of notes to avoid showing the user "500.00 INR (FX rate:
  0.01109) • Coffee" when they just want "Coffee".

When an account has no FX rule, its balance is in the budget's base
currency and there is no "currency" / "nativeBalance" / "native" field.
In that case fall back to plain decimal display with no symbol.

CRITICAL: even when you know a per-account currency, do NOT extrapolate
it to other accounts or to the budget as a whole. Each account stands
alone. Only emit a currency symbol next to a number when that specific
number came from an account with a known currency.

WHICH TOOL TO USE
Most "how much did I spend" style questions are answered by the QUERY
tools, not the BUDGETS tools. Budgets tools describe the user's planned
envelopes and only return non-zero data when the user has actively
budgeted amounts for the period. If they have not, budget totals are
ZERO — do not report that as "no spending".

- "How much did I spend this month?" → arc_query_spending (per-category
  actual spend from transactions) OR arc_query_monthly (month totals).
- "Monthly totals over time / trends" → arc_query_monthly or arc_query_trends.
- "Top spending categories" → arc_query_top.
- "Spend by payee" → arc_query_payee.
- "Spend in one category" → arc_query_category.
- "Uncategorized transactions" → arc_query_uncategorized.
- "Account balance / balance history" → arc_accounts_balance or
  arc_query_balance_history / arc_query_monthly_balances.
- "Raw transaction list for a period" → arc_transactions_list.

Use the BUDGETS tools only when the question is explicitly about the
user's planned envelopes:
- "Am I over budget for X?" → arc_budgets_month.
- "What did I budget for X?" → arc_budgets_month.
- "Show me my income for the month" → arc_budgets_income.
- "Set/move a budgeted amount" → arc_budgets_set_amount /
  arc_budgets_set_carryover / arc_budgets_transfer.

SCOPE
Arc only talks to Actual Budget. There is no other backend, database,
or storage layer — do not mention Convex, Postgres, or anything else.
Advanced tools (delete, merge, batch_*, custom query, budgets_switch)
mutate state irreversibly; prefer safer tools and double-check inputs
before calling them.`;

/** Build an MCP server whose tools are driven by the public operation registry. */
export function createMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'arc', version: '1.0.0' },
    { instructions: MCP_INSTRUCTIONS }
  );

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
    // Suffix the description of any tool that returns amount-bearing data
    // with a compact minor-units reminder. MCP clients that do not load
    // SKILL.md (like Claude Desktop) read the per-tool description when
    // deciding how to present results — this is the cheapest place to
    // stop them formatting 37936 as "37,936" or "₹37,936".
    const description = decorateDescription(op);

    server.registerTool(
      op.mcpTool,
      {
        description,
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
 * Cached client with an idle-timeout so the MCP server doesn't hold the
 * Actual session (and its SQLite lock, memory, and sync-traffic footprint)
 * indefinitely.
 *
 * The old per-tool-call connect pattern paid 5–10s on every Claude tool
 * call and created parallel-connect races when a single Claude turn fired
 * multiple tools. Caching for the whole MCP process lifetime fixed the
 * latency but kept the Actual session alive for hours, blocking the TUI
 * and other arc processes from acquiring the same DB files.
 *
 * The middle ground: cache for the duration of an active chat, then
 * release when idle. A 90-second default covers typical Claude Desktop
 * conversations (one tool call per turn, turns a few seconds apart)
 * while still freeing the DB between conversations. Tunable via the
 * `ARC_MCP_IDLE_TIMEOUT_MS` env var; set to `0` to disable the timeout
 * entirely (lifetime-cached), or set to `-1` to revert to the legacy
 * per-call reconnect behaviour.
 *
 * A connect-in-flight mutex serialises the first connect when multiple
 * parallel tool calls race, preventing duplicate `actualApi.init()`s.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

function resolveIdleTimeoutMs(): number {
  const raw = process.env.ARC_MCP_IDLE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_IDLE_TIMEOUT_MS;
  return parsed;
}

let cachedDeps: McpHandlerDeps | null = null;
let connectInFlight: Promise<McpHandlerDeps> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let shutdownInstalled = false;

async function releaseCachedClient(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const current = cachedDeps;
  cachedDeps = null;
  if (!current) return;
  try {
    await current.client.disconnect();
  } catch {
    try { await current.client.api.shutdown(); } catch { /* best effort */ }
  }
}

function scheduleIdleRelease(): void {
  const timeoutMs = resolveIdleTimeoutMs();
  if (timeoutMs <= 0) return; // 0 = lifetime-cached, negative = legacy path uses this
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void releaseCachedClient();
  }, timeoutMs);
  // Don't let the idle timer keep the process alive on its own.
  idleTimer.unref?.();
}

async function ensureCachedClient(): Promise<McpHandlerDeps> {
  if (cachedDeps) return cachedDeps;
  if (connectInFlight) return connectInFlight;

  connectInFlight = (async () => {
    const client = ActualClient.fromEnv();
    await client.connect();
    const backup = new BackupManager();
    const writer = new SafeWriter(client, backup);
    const deps: McpHandlerDeps = { client, writer };
    cachedDeps = deps;

    if (!shutdownInstalled) {
      shutdownInstalled = true;
      process.on('SIGINT', () => { void releaseCachedClient().finally(() => process.exit(0)); });
      process.on('SIGTERM', () => { void releaseCachedClient().finally(() => process.exit(0)); });
      process.on('beforeExit', () => { void releaseCachedClient(); });
    }

    return deps;
  })();

  try {
    return await connectInFlight;
  } finally {
    connectInFlight = null;
  }
}

/**
 * Production dep resolver. Behaviour is controlled by ARC_MCP_IDLE_TIMEOUT_MS:
 *
 * - `> 0` (default 90_000): cache the client, auto-release after N ms of idle.
 *   Each tool call resets the idle timer so active conversations stay fast.
 * - `0`: cache for the lifetime of the MCP process (never release).
 * - `< 0`: legacy path — open + disconnect per call. Paid 5–10s per tool.
 */
async function withRealClient(): Promise<{
  deps: McpHandlerDeps;
  cleanup: () => Promise<void>;
}> {
  const timeoutMs = resolveIdleTimeoutMs();

  if (timeoutMs < 0) {
    // Legacy per-call path.
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

  // Cached path (timeoutMs >= 0). Reset idle timer on every call so an
  // active conversation keeps the client warm; it releases only after a
  // full idle window with no activity.
  const deps = await ensureCachedClient();
  if (timeoutMs > 0) scheduleIdleRelease();
  return {
    deps,
    cleanup: async () => { /* no-op: client lives for the idle window */ },
  };
}

// ── Production entry points ─────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export interface HttpMcpServerOptions {
  /** Port to listen on. Default 8765. */
  port?: number;
  /** Host to bind to. Default 127.0.0.1 (loopback only). Pass "0.0.0.0" to expose. */
  host?: string;
  /**
   * Bearer token clients must present in the `Authorization: Bearer <token>`
   * header. If omitted we generate a random one and print it on startup so
   * the operator can copy it into Claude.ai / mobile / etc.
   *
   * Loopback-only deployments (default host 127.0.0.1) can run without a
   * token by passing the empty string, but anything bound to a public
   * interface MUST set a token — without it, anyone reaching the port can
   * read and write the budget.
   */
  token?: string;
  /** Optional fixed mount path. Default "/mcp". */
  path?: string;
}

/**
 * Start arc as a Streamable HTTP MCP server. This is the transport
 * Claude.ai (web + mobile) and Cursor's remote-MCP feature use, which
 * means once you tunnel the port (cloudflare tunnel, tailscale funnel,
 * ngrok, etc.) the same 59 tools that Claude Desktop sees are reachable
 * from anywhere on your phone.
 *
 * Architecture:
 *   - One Node http.Server bound to host:port.
 *   - On every POST /mcp the same `createMcpServer()` factory is run
 *     against a fresh `StreamableHTTPServerTransport` (stateless mode —
 *     each tool call is its own request, no session state on the server
 *     side). The cached ActualClient inside `withRealClient()` is shared
 *     across all requests just like in stdio mode.
 *   - Bearer-token auth gates every request. The token is constant-time
 *     compared to defeat timing attacks.
 *
 * Usage:
 *   arc mcp --http                          # loopback only, random token
 *   arc mcp --http --host 0.0.0.0 --token <secret>
 *   arc mcp --http --port 9000 --token "$ARC_MCP_TOKEN"
 */
export async function startHttpMcpServer(opts: HttpMcpServerOptions = {}): Promise<{
  url: string;
  token: string;
  close: () => Promise<void>;
}> {
  const port = opts.port ?? 8765;
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/mcp';
  const token = opts.token ?? randomUUID();
  const tokenBytes = Buffer.from(token, 'utf8');

  const requireAuth = token.length > 0;
  if (!requireAuth && host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(
      `Refusing to start arc mcp http on ${host}:${port} without an auth token. ` +
      `Pass --token <secret> or bind to 127.0.0.1.`
    );
  }

  // Constant-time bearer-token check. Reject any request without the
  // exact token in the Authorization header so a public tunnel can't be
  // probed by random scanners.
  function checkAuth(req: IncomingMessage): boolean {
    if (!requireAuth) return true;
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const presented = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8');
    if (presented.length !== tokenBytes.length) return false;
    try {
      return timingSafeEqual(presented, tokenBytes);
    } catch {
      return false;
    }
  }

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight: Claude.ai's mobile app issues an OPTIONS preflight
    // before its first POST. Echo back the headers it asks for so the
    // browser/SwiftUI client doesn't drop the request.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, mcp-session-id',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    if (!req.url || !req.url.startsWith(path)) {
      res.writeHead(404).end();
      return;
    }

    if (!checkAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="arc"' }).end('Unauthorized');
      return;
    }

    // Stateless mode: each request gets its own transport + server. The
    // expensive Actual client is reused across requests via the module-
    // level cache inside withRealClient(), so the per-request overhead
    // is just the in-memory MCP plumbing.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer();

    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
      await server.connect(transport);
      // The Node-flavoured StreamableHTTPServerTransport accepts the raw
      // IncomingMessage/ServerResponse pair and parses the JSON body
      // itself.
      await transport.handleRequest(req, res);
    } catch (err) {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      } catch { /* response may already be flushed */ }
    } finally {
      try { await transport.close(); } catch { /* best effort */ }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  const url = `http://${displayHost}:${port}${path}`;

  // Print the connection details so the operator can paste them into
  // Claude.ai or any other remote-MCP client. We deliberately log to
  // stderr because stdio mode would otherwise share stdout.
  console.error('');
  console.error(`  arc mcp ready (Streamable HTTP)`);
  console.error(`    URL:   ${url}`);
  if (requireAuth) {
    console.error(`    Token: ${token}`);
    console.error('');
    console.error('  Add to Claude.ai → Settings → Connectors → Custom MCP Server:');
    console.error(`    URL:                  <tunnel-url>${path}`);
    console.error(`    Authorization header: Bearer ${token}`);
  } else {
    console.error('  Auth: disabled (loopback only).');
  }
  console.error('');

  return {
    url,
    token,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
