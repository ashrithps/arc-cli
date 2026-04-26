#!/usr/bin/env node

import 'dotenv/config';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { ActualClient } from './client.js';
import { BackupManager } from './backup.js';
import { SafeWriter } from './safe-writer.js';
import { getBudgetPassword, getInstalledConfig, persistBudgetCatalog, saveBootstrapPayload } from './credential-store.js';
import * as accounts from './operations/accounts.js';
import * as transactions from './operations/transactions.js';
import * as categories from './operations/categories.js';
import * as payees from './operations/payees.js';
import * as rules from './operations/rules.js';
import * as schedules from './operations/schedules.js';
import * as budgets from './operations/budgets.js';
import * as queries from './operations/queries.js';
import * as tags from './operations/tags.js';
import { amountToCents, formatCurrency, printTable, printJson } from './utils/format.js';
import { makeImportedId } from './utils/imported-id.js';
import { parseInstallPayload } from './payload.js';
import { startMcpServer, startHttpMcpServer } from './mcp/server.js';
import * as ui from './ui/views.js';
import {
  isDaemonRunning,
  readStatus,
  sendDaemonRequest,
  startDaemonProcess,
  stopDaemonProcess,
  waitForDaemon,
} from './session-manager.js';

// ── Arg parsing ───────────────────────────────────────────────

export interface ParsedArgs {
  command: string;
  subcommand: string;
  flags: Record<string, string>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] || 'help';
  const subcommand = args[1] && !args[1].startsWith('--') ? args[1] : '';
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = subcommand ? 2 : 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = 'true';
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, subcommand: subcommand || 'list', flags, positional };
}

export function getFlag(flags: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (flags[key] != null) return flags[key];
  }
  return undefined;
}

export function requireFlag(flags: Record<string, string>, ...keys: string[]): string {
  const val = getFlag(flags, ...keys);
  if (val == null) throw new Error(`Required flag: --${keys[0]}`);
  return val;
}

export const isJson = (flags: Record<string, string>) => flags.json === 'true';

function getClearedFlag(flags: Record<string, string>, defaultValue = true): boolean {
  return flags.cleared != null ? flags.cleared === 'true' : defaultValue;
}

// Normalization helpers live in `src/operations/normalizers.ts` so that both
// the CLI dispatcher and the MCP server can import them without pulling in
// index.ts's side-effectful command table.
import { normalizeRulePayload, normalizeSchedulePayload } from './operations/normalizers.js';
export { normalizeRulePayload, normalizeSchedulePayload };

// ── Command handlers ──────────────────────────────────────────

async function handleFiles(client: ActualClient, flags: Record<string, string>) {
  // List available budget files without loading one
  await client.init();
  const budgets = await client.listBudgets();

  if (budgets.length === 0) {
    console.log('No budget files found on this server.');
    return;
  }

  if (isJson(flags)) return printJson(budgets);
  ui.printBudgetFiles(budgets, client.getConfig().serverURL);
}

async function handleConnect(client: ActualClient, flags: Record<string, string>) {
  const accts = await client.api.getAccounts();
  if (isJson(flags)) return printJson(accts);
  ui.printConnection({
    serverURL: client.getConfig().serverURL,
    budgetSyncId: client.getConfig().budgetSyncId,
    encrypted: !!client.getConfig().encryptionPassword,
  }, accts);
}

async function handleAccounts(client: ActualClient, writer: SafeWriter, sub: string, flags: Record<string, string>) {
  switch (sub) {
    case 'list': {
      const list = await accounts.listAccounts(client);
      if (isJson(flags)) return printJson(list);
      ui.printAccounts(list);
      break;
    }
    case 'balance': {
      const id = await accounts.resolveAccountId(client, requireFlag(flags, 'account', 'id'));
      const bal = await accounts.getAccountBalance(client, id);
      // --json must return the integer minor-units value to stay
      // consistent with every other arc command and the MCP contract.
      // Human-readable mode renders the formatted decimal.
      if (isJson(flags)) return printJson({ id, balance: bal });
      console.log(formatCurrency(bal));
      break;
    }
    case 'create': {
      const name = requireFlag(flags, 'name');
      const type = getFlag(flags, 'type');
      const offbudget = getFlag(flags, 'offbudget') === 'true';
      const balance = getFlag(flags, 'balance');
      const initialBalance = balance ? amountToCents(parseFloat(balance)) : 0;
      const id = await accounts.createAccount(client, writer, name, type, offbudget, initialBalance);
      console.log(`Created account: ${name} (${id})`);
      break;
    }
    case 'update': {
      const id = await accounts.resolveAccountId(client, requireFlag(flags, 'id', 'account'));
      const fields: any = {};
      if (flags.name) fields.name = flags.name;
      if (flags.type) fields.type = flags.type;
      if (flags.offbudget) fields.offbudget = flags.offbudget === 'true';
      await accounts.updateAccount(client, writer, id, fields);
      console.log('Account updated.');
      break;
    }
    case 'close': {
      const id = await accounts.resolveAccountId(client, requireFlag(flags, 'id', 'account'));
      const transferTo = getFlag(flags, 'transfer-to');
      const transferToId = transferTo ? await accounts.resolveAccountId(client, transferTo) : undefined;
      await accounts.closeAccount(client, writer, id, transferToId);
      console.log('Account closed.');
      break;
    }
    case 'reopen': {
      const id = await accounts.resolveAccountId(client, requireFlag(flags, 'id', 'account'));
      await accounts.reopenAccount(client, writer, id);
      console.log('Account reopened.');
      break;
    }
    case 'delete': {
      const id = await accounts.resolveAccountId(client, requireFlag(flags, 'id', 'account'));
      await accounts.deleteAccount(client, writer, id);
      console.log('Account deleted.');
      break;
    }
    default:
      throw new Error(`Unknown accounts subcommand: ${sub}. Use: list, balance, create, update, close, reopen, delete`);
  }
}

async function handleTransactions(client: ActualClient, writer: SafeWriter, sub: string, flags: Record<string, string>, positional: string[]) {
  switch (sub) {
    case 'list': {
      const start = getFlag(flags, 'start');
      const end = getFlag(flags, 'end');
      const tagFilter = getFlag(flags, 'tag');
      // `--tag=A,B` filters across ALL accounts (multi-tag = AND match).
      // When `--tag` is set, `--account` is optional; otherwise required.
      if (tagFilter) {
        const tagNames = tagFilter.split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);
        let txns = await tags.listTransactionsByTags(client, tagNames, start, end);
        const accountFlag = getFlag(flags, 'account');
        if (accountFlag) {
          const accountId = await accounts.resolveAccountId(client, accountFlag);
          txns = txns.filter((t: any) => t.account === accountId);
        }
        if (isJson(flags)) return printJson(txns);
        ui.printTransactions(txns, `tag:${tagNames.join(',')}`);
        break;
      }
      const accountName = requireFlag(flags, 'account');
      const accountId = await accounts.resolveAccountId(client, accountName);
      const txns = await transactions.listTransactions(client, accountId, start, end);
      if (isJson(flags)) return printJson(txns);
      const acctObj = await accounts.findAccountByName(client, accountName);
      ui.printTransactions(txns, acctObj?.name || accountName);
      break;
    }
    case 'add': {
      const accountName = requireFlag(flags, 'account');
      const accountId = await accounts.resolveAccountId(client, accountName);
      const date = requireFlag(flags, 'date');
      const amount = amountToCents(parseFloat(requireFlag(flags, 'amount')));
      const tx: any = { date, amount };
      if (flags.payee) tx.payee_name = flags.payee;
      if (flags.category) {
        const cat = await categories.findCategoryByName(client, flags.category);
        if (cat) tx.category = cat.id;
        else console.warn(`Warning: category "${flags.category}" not found, skipping.`);
      }
      if (flags.notes) tx.notes = flags.notes;
      // `--tag=A,B` appends `#A #B` to notes (Actual native format) and
      // ensures both tags exist in the synced `tags` table so colors roam.
      if (flags.tag) {
        const tagNames = flags.tag.split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);
        await tags.ensureTagsExist(client, writer, tagNames);
        let notes = tx.notes ?? '';
        for (const name of tagNames) notes = tags.addTagToken(notes, name);
        tx.notes = notes;
      }
      tx.cleared = getClearedFlag(flags);
      tx.imported_id = flags['imported-id'] || makeImportedId([
        accountId,
        date,
        amount,
        tx.payee_name || '',
        tx.notes || '',
      ]);
      await transactions.importTransaction(client, writer, accountId, tx);
      console.log('Imported transaction.');
      break;
    }
    case 'import': {
      const accountName = requireFlag(flags, 'account');
      const accountId = await accounts.resolveAccountId(client, accountName);
      const data = positional[0] || requireFlag(flags, 'data');
      const txs = JSON.parse(data);
      const result = await transactions.importTransactions(client, writer, accountId, txs);
      console.log(`Import: ${result.added} added, ${result.updated} updated, ${result.errors.length} errors`);
      if (result.errors.length > 0) printJson(result.errors);
      break;
    }
    case 'update': {
      const id = requireFlag(flags, 'id');
      const fields: any = {};
      if (flags.amount) fields.amount = amountToCents(parseFloat(flags.amount));
      if (flags.date) fields.date = flags.date;
      if (flags.notes) fields.notes = flags.notes;
      if (flags.cleared) fields.cleared = flags.cleared === 'true';
      if (flags.category) {
        const cat = await categories.findCategoryByName(client, flags.category);
        if (cat) fields.category = cat.id;
      }
      if (flags.payee) {
        // Try to find existing payee, create if not found
        let payee = await payees.findPayeeByName(client, flags.payee);
        if (!payee) {
          const newId = await payees.createPayee(client, writer, flags.payee);
          fields.payee = newId;
        } else {
          fields.payee = payee.id;
        }
      }
      await transactions.updateTransaction(client, writer, id, fields);
      // Tag mutations are notes rewrites layered on top of the update above.
      // Done after the main update so the latest notes value is what we read.
      if (flags['add-tag']) {
        const adds = flags['add-tag'].split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);
        await tags.addTagsToTransaction(client, writer, id, adds);
      }
      if (flags['remove-tag']) {
        const removes = flags['remove-tag'].split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);
        await tags.removeTagsFromTransaction(client, writer, id, removes);
      }
      console.log('Transaction updated.');
      break;
    }
    case 'delete': {
      const id = requireFlag(flags, 'id');
      await transactions.deleteTransaction(client, writer, id);
      console.log('Transaction deleted.');
      break;
    }
    case 'split': {
      // Subs format: [{amount, category?, notes?, payee?, transfer_account?}]
      // transfer_account creates a linked transfer as a child of the split
      const accountName = requireFlag(flags, 'account');
      const accountId = await accounts.resolveAccountId(client, accountName);
      const date = requireFlag(flags, 'date');
      const subsData = requireFlag(flags, 'subs');
      const subs = JSON.parse(subsData);
      const subsCents = subs.map((s: any) => ({ ...s, amount: amountToCents(s.amount) }));
      for (const s of subsCents) {
        if (s.category && !/^[a-f0-9-]{8,}$/.test(s.category)) {
          const cat = await categories.findCategoryByName(client, s.category);
          if (cat) s.category = cat.id;
        }
      }
      // Resolve parent payee to ID if it's a name
      let parentPayeeId: string | undefined;
      if (flags.payee) {
        const p = await payees.findPayeeByName(client, flags.payee);
        parentPayeeId = p?.id;
      }
      const id = await transactions.createSplitTransaction(client, writer, accountId, {
        date, payee_name: flags.payee, payee: parentPayeeId, notes: flags.notes, cleared: getClearedFlag(flags),
      }, subsCents);
      console.log(`Created split transaction: ${id}`);
      break;
    }
    case 'transfer': {
      const fromId = await accounts.resolveAccountId(client, requireFlag(flags, 'from'));
      const toId = await accounts.resolveAccountId(client, requireFlag(flags, 'to'));
      const amount = amountToCents(parseFloat(requireFlag(flags, 'amount')));
      const foreignAmount = getFlag(flags, 'foreign-amount');
      const date = requireFlag(flags, 'date');
      const id = await transactions.createTransfer(
        client,
        writer,
        fromId,
        toId,
        amount,
        date,
        flags.notes,
        getClearedFlag(flags),
        foreignAmount != null ? amountToCents(parseFloat(foreignAmount)) : undefined
      );
      console.log(`Created transfer: ${id}`);
      break;
    }
    case 'batch-update': {
      // Takes JSON array of {id, payee?, category?, notes?, amount?, date?}
      const data = positional[0] || requireFlag(flags, 'data');
      const updates = JSON.parse(data);
      let count = 0;
      for (const upd of updates) {
        const fields: any = {};
        if (upd.amount != null) fields.amount = amountToCents(upd.amount);
        if (upd.date) fields.date = upd.date;
        if (upd.notes) fields.notes = upd.notes;
        if (upd.cleared != null) fields.cleared = upd.cleared;
        if (upd.category) {
          const cat = await categories.findCategoryByName(client, upd.category);
          if (cat) fields.category = cat.id;
        }
        if (upd.payee) {
          let payee = await payees.findPayeeByName(client, upd.payee);
          if (!payee) {
            const newId = await payees.createPayee(client, writer, upd.payee);
            fields.payee = newId;
          } else {
            fields.payee = payee.id;
          }
        }
        if (Object.keys(fields).length > 0) {
          await transactions.updateTransaction(client, writer, upd.id, fields);
          count++;
        }
      }
      console.log(`Batch updated ${count} transactions.`);
      break;
    }
    case 'batch-add': {
      // JSON array of {date, amount, payee_name?, category?, notes?, cleared?}
      const accountName = requireFlag(flags, 'account');
      const accountId = await accounts.resolveAccountId(client, accountName);
      const data = positional[0] || requireFlag(flags, 'data');
      const txnList = JSON.parse(data);

      // Resolve category names to IDs and convert amounts
      const prepared = [];
      for (const t of txnList) {
        const tx: any = {
          date: t.date,
          amount: amountToCents(t.amount),
          cleared: t.cleared ?? true,
        };
        if (t.payee_name || t.payee) tx.payee_name = t.payee_name || t.payee;
        if (t.notes) tx.notes = t.notes;
        if (t.imported_id) tx.imported_id = t.imported_id;
        if (t.category) {
          if (/^[a-f0-9-]{8,}$/.test(t.category)) {
            tx.category = t.category;
          } else {
            const cat = await categories.findCategoryByName(client, t.category);
            if (cat) tx.category = cat.id;
          }
        }
        prepared.push(tx);
      }

      for (const tx of prepared) {
        tx.imported_id = tx.imported_id || makeImportedId([
          accountId,
          tx.date,
          tx.amount,
          tx.payee_name || '',
          tx.notes || '',
        ]);
      }

      const result = await transactions.importTransactions(client, writer, accountId, prepared);
      console.log(`Import: ${result.added} added, ${result.updated} updated, ${result.errors.length} errors`);
      break;
    }
    case 'batch-categorize': {
      // Categorize all transactions matching a payee pattern
      const accountName = requireFlag(flags, 'account');
      const accountId = await accounts.resolveAccountId(client, accountName);
      const payeePattern = requireFlag(flags, 'payee');
      const categoryName = requireFlag(flags, 'category');

      const cat = await categories.findCategoryByName(client, categoryName);
      if (!cat) throw new Error(`Category not found: ${categoryName}`);

      const start = getFlag(flags, 'start');
      const end = getFlag(flags, 'end');
      const allTxns = await transactions.listTransactions(client, accountId, start, end);

      // Find uncategorized transactions matching payee
      const pattern = payeePattern.toLowerCase();
      const allPayees = await payees.listPayees(client);
      const payeeMap: Record<string, string> = {};
      for (const p of allPayees) payeeMap[p.id] = p.name;

      const matches = allTxns.filter((t: any) => {
        if (t.category) return false; // already categorized
        if (t.is_parent || t.is_child || t.transfer_id) return false;
        const pName = (t.payee_name || t.imported_payee || payeeMap[t.payee] || '').toLowerCase();
        return pName.includes(pattern);
      });

      if (matches.length === 0) {
        console.log(`No uncategorized transactions matching "${payeePattern}".`);
        break;
      }

      console.log(`Found ${matches.length} uncategorized transactions matching "${payeePattern}":`);
      for (const t of matches.slice(0, 10)) {
        const pName = t.payee_name || t.imported_payee || payeeMap[t.payee] || '';
        console.log(`  ${t.date} | ${pName.slice(0, 25).padEnd(25)} | ${formatCurrency(t.amount)}`);
      }
      if (matches.length > 10) console.log(`  ... and ${matches.length - 10} more`);

      // Apply category
      let count = 0;
      for (const t of matches) {
        try {
          await transactions.updateTransaction(client, writer, t.id, { category: cat.id });
          count++;
        } catch {}
      }
      console.log(`Categorized ${count} transactions as "${categoryName}".`);
      break;
    }
    default:
      throw new Error(`Unknown transactions subcommand: ${sub}. Use: list, add, import, update, delete, split, transfer, batch-update, batch-add, batch-categorize`);
  }
}

async function handleDoctor(client: ActualClient, flags: Record<string, string>) {
  const accountsList = await client.api.getAccounts();
  const payeesList = await client.api.getPayees();
  const categoriesList = await client.api.getCategories();
  const rulesList = await client.api.getRules();
  const lockPath = client.getLockPath();

  const payload = {
    serverURL: client.getConfig().serverURL,
    budgetSyncId: client.getConfig().budgetSyncId,
    accounts: accountsList.length,
    payees: payeesList.length,
    categories: categoriesList.length,
    rules: rulesList.length,
    writeLockPresent: fs.existsSync(lockPath),
    lockPath,
  };

  if (isJson(flags)) return printJson(payload);

  ui.printSuccess('Actual connection healthy');
  ui.printInfo(`Budget: ${payload.budgetSyncId || 'auto-selected'}`);
  ui.printInfo(`Accounts: ${payload.accounts} | Payees: ${payload.payees} | Categories: ${payload.categories} | Rules: ${payload.rules}`);
  ui.printInfo(`Write lock: ${payload.writeLockPresent ? 'present' : 'clear'}`);
}

async function handleCategories(client: ActualClient, writer: SafeWriter, sub: string, flags: Record<string, string>) {
  switch (sub) {
    case 'list': {
      const groups = await categories.listCategoryGroups(client);
      if (isJson(flags)) return printJson(groups);
      ui.printCategories(groups);
      break;
    }
    case 'create': {
      const name = requireFlag(flags, 'name');
      const groupId = await categories.resolveCategoryGroupId(client, requireFlag(flags, 'group'));
      const isIncome = getFlag(flags, 'income') === 'true';
      const id = await categories.createCategory(client, writer, name, groupId, isIncome);
      console.log(`Created category: ${name} (${id})`);
      break;
    }
    case 'update': {
      const id = await categories.resolveCategoryId(client, requireFlag(flags, 'id'));
      const fields: any = {};
      if (flags.name) fields.name = flags.name;
      if (flags.group) fields.group_id = await categories.resolveCategoryGroupId(client, flags.group);
      if (flags.hidden) fields.hidden = flags.hidden === 'true';
      await categories.updateCategory(client, writer, id, fields);
      console.log('Category updated.');
      break;
    }
    case 'delete': {
      const id = await categories.resolveCategoryId(client, requireFlag(flags, 'id'));
      const transferTo = getFlag(flags, 'transfer-to');
      const transferToId = transferTo ? await categories.resolveCategoryId(client, transferTo) : undefined;
      await categories.deleteCategory(client, writer, id, transferToId);
      console.log('Category deleted.');
      break;
    }
    default:
      throw new Error(`Unknown categories subcommand: ${sub}`);
  }
}

async function handlePayees(client: ActualClient, writer: SafeWriter, sub: string, flags: Record<string, string>) {
  switch (sub) {
    case 'list': {
      const list = await payees.listPayees(client);
      if (isJson(flags)) return printJson(list);
      ui.printPayees(list, flags.all === 'true');
      break;
    }
    case 'create': {
      const name = requireFlag(flags, 'name');
      const id = await payees.createPayee(client, writer, name);
      console.log(`Created payee: ${name} (${id})`);
      break;
    }
    case 'update': {
      const id = await payees.resolvePayeeId(client, requireFlag(flags, 'id'));
      const fields: any = {};
      if (flags.name) fields.name = flags.name;
      await payees.updatePayee(client, writer, id, fields);
      console.log('Payee updated.');
      break;
    }
    case 'delete': {
      const id = await payees.resolvePayeeId(client, requireFlag(flags, 'id'));
      await payees.deletePayee(client, writer, id);
      console.log('Payee deleted.');
      break;
    }
    case 'merge': {
      const targetName = requireFlag(flags, 'target');
      const mergeNames = requireFlag(flags, 'merge').split(',').map(s => s.trim());
      const targetId = await payees.resolvePayeeId(client, targetName);
      const mergeIds: string[] = [];
      for (const name of mergeNames) {
        mergeIds.push(await payees.resolvePayeeId(client, name));
      }
      await payees.mergePayees(client, writer, targetId, mergeIds);
      console.log(`Merged ${mergeIds.length} payees into "${targetName}".`);
      break;
    }
    case 'find-or-create': {
      const name = requireFlag(flags, 'name');
      const id = await payees.findOrCreatePayee(client, writer, name);
      console.log(`Payee: ${name} (${id})`);
      break;
    }
    case 'common': {
      const limit = parseInt(getFlag(flags, 'limit') || '20');
      const common = await payees.getCommonPayees(client, limit);
      if (isJson(flags)) return printJson(common);
      for (const p of common) {
        console.log(`  ${p.count.toString().padStart(4)} txns  ${p.name}`);
      }
      break;
    }
    default:
      throw new Error(`Unknown payees subcommand: ${sub}. Use: list, create, update, delete, merge, find-or-create, common`);
  }
}

async function handleTags(client: ActualClient, writer: SafeWriter, sub: string, flags: Record<string, string>) {
  switch (sub) {
    case 'list': {
      const list = await tags.listTags(client);
      if (isJson(flags)) return printJson(list);
      ui.printTags(list);
      break;
    }
    case 'add': {
      const name = requireFlag(flags, 'name').replace(/^#/, '');
      const color = getFlag(flags, 'color');
      const description = getFlag(flags, 'description');
      const tag = await tags.createTag(client, writer, { tag: name, color, description });
      console.log(`Created tag: ${tag.tag} (${tag.id})`);
      break;
    }
    case 'update': {
      const id = await tags.resolveTagId(client, requireFlag(flags, 'id'));
      const fields: any = {};
      if (flags.name) fields.tag = flags.name.replace(/^#/, '');
      if (flags.color !== undefined) fields.color = flags.color;
      if (flags.description !== undefined) fields.description = flags.description;
      await tags.updateTag(client, writer, id, fields);
      console.log('Tag updated.');
      break;
    }
    case 'delete': {
      const id = await tags.resolveTagId(client, requireFlag(flags, 'id'));
      await tags.deleteTag(client, writer, id);
      console.log('Tag deleted.');
      break;
    }
    case 'apply': {
      const txId = requireFlag(flags, 'transaction');
      const tagNames = requireFlag(flags, 'tag').split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);
      await tags.addTagsToTransaction(client, writer, txId, tagNames);
      console.log(`Applied ${tagNames.length} tag(s) to ${txId}.`);
      break;
    }
    case 'unapply': {
      const txId = requireFlag(flags, 'transaction');
      const tagNames = requireFlag(flags, 'tag').split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);
      await tags.removeTagsFromTransaction(client, writer, txId, tagNames);
      console.log(`Removed ${tagNames.length} tag(s) from ${txId}.`);
      break;
    }
    default:
      throw new Error(`Unknown tags subcommand: ${sub}. Use: list, add, update, delete, apply, unapply`);
  }
}

async function handleRules(client: ActualClient, writer: SafeWriter, sub: string, flags: Record<string, string>, positional: string[]) {
  switch (sub) {
    case 'list': {
      const list = await rules.listRules(client);
      if (isJson(flags)) return printJson(list);
      ui.printRules(list);
      break;
    }
    case 'create': {
      const data = positional[0] || requireFlag(flags, 'data');
      const id = await rules.createRule(client, writer, await normalizeRulePayload(client, JSON.parse(data)));
      console.log(`Created rule: ${id}`);
      break;
    }
    case 'update': {
      const data = positional[0] || requireFlag(flags, 'data');
      const updated = await rules.updateRule(client, writer, await normalizeRulePayload(client, JSON.parse(data)));
      console.log(`Updated rule: ${updated.id}`);
      break;
    }
    case 'delete': {
      await rules.deleteRule(client, writer, requireFlag(flags, 'id'));
      console.log('Rule deleted.');
      break;
    }
    default:
      throw new Error(`Unknown rules subcommand: ${sub}`);
  }
}

async function handleSchedules(client: ActualClient, writer: SafeWriter, sub: string, flags: Record<string, string>, positional: string[]) {
  switch (sub) {
    case 'list': {
      const list = await schedules.listSchedules(client);
      if (isJson(flags)) return printJson(list);
      ui.printSchedules(list);
      break;
    }
    case 'create': {
      const data = positional[0] || requireFlag(flags, 'data');
      const id = await schedules.createSchedule(client, writer, await normalizeSchedulePayload(client, JSON.parse(data)));
      console.log(`Created schedule: ${id}`);
      break;
    }
    case 'update': {
      const id = requireFlag(flags, 'id');
      const data = positional[0] || requireFlag(flags, 'data');
      await schedules.updateSchedule(client, writer, id, await normalizeSchedulePayload(client, JSON.parse(data)));
      console.log('Schedule updated.');
      break;
    }
    case 'delete': {
      await schedules.deleteSchedule(client, writer, requireFlag(flags, 'id'));
      console.log('Schedule deleted.');
      break;
    }
    case 'post': {
      const id = requireFlag(flags, 'id');
      const date = getFlag(flags, 'date');
      const txnId = await schedules.postSchedule(client, writer, id, date);
      console.log(`Posted schedule as transaction: ${txnId}`);
      break;
    }
    case 'upcoming': {
      const upcoming = await schedules.getUpcomingSchedules(client);
      if (isJson(flags)) return printJson(upcoming);
      if (upcoming.length === 0) {
        console.log('No upcoming schedules.');
        break;
      }
      console.log(`\nUpcoming schedules (${upcoming.length}):\n`);
      console.log(`  ${'Next Date'.padEnd(12)} ${'Name'.padEnd(25)} ${'Amount'.padStart(12)}`);
      console.log(`  ${'─'.repeat(51)}`);
      for (const s of upcoming) {
        const name = (s.name || 'Unnamed').slice(0, 23).padEnd(25);
        const amt = s._amount || s.amount || 0;
        console.log(`  ${(s.next_date || '?').padEnd(12)} ${name} ${formatCurrency(amt).padStart(12)}`);
      }
      console.log('');
      break;
    }
    case 'complete': {
      await schedules.completeSchedule(client, writer, requireFlag(flags, 'id'));
      console.log('Schedule marked as completed.');
      break;
    }
    default:
      throw new Error(`Unknown schedules subcommand: ${sub}. Use: list, create, update, delete, post, upcoming, complete`);
  }
}

async function handleBudgets(client: ActualClient, writer: SafeWriter, sub: string, flags: Record<string, string>) {
  switch (sub) {
    case 'list': {
      const catalog = await listBudgetCatalog(client);
      if (isJson(flags)) return printJson(catalog);
      ui.printBudgetFiles(catalog.map(entry => ({
        groupId: entry.syncId,
        cloudFileId: entry.cloudFileId,
        name: entry.name,
        encryptKeyId: entry.isEncrypted ? 'encrypted' : undefined,
      })), client.getConfig().serverURL);
      break;
    }
    case 'months': {
      const months = await budgets.getBudgetMonths(client);
      if (isJson(flags)) return printJson(months);
      console.log('Budget months:');
      months.forEach(m => console.log(`  ${m}`));
      break;
    }
    case 'switch': {
      const context = await client.switchBudget({
        budgetRef: requireFlag(flags, 'budget'),
        password: getFlag(flags, 'password'),
        isInteractive: !!(process.stdin.isTTY && process.stdout.isTTY),
      });
      if (isJson(flags)) {
        return printJson({
          syncId: context.groupId,
          cloudFileId: context.cloudFileId,
          name: context.name,
          hasSavedPassword: !!getBudgetPassword(context.groupId),
        });
      }
      console.log(`Switched to ${context.name} (${context.groupId})`);
      break;
    }
    case 'month': case 'show': {
      const month = requireFlag(flags, 'month');
      const budget = await budgets.getBudgetMonth(client, month);
      if (isJson(flags)) return printJson(budget);
      ui.printBudgetMonth(budget, month);
      break;
    }
    case 'set-amount': {
      const month = requireFlag(flags, 'month');
      const categoryName = requireFlag(flags, 'category');
      const amount = amountToCents(parseFloat(requireFlag(flags, 'amount')));
      const cat = await categories.findCategoryByName(client, categoryName);
      if (!cat) throw new Error(`Category not found: ${categoryName}`);
      await budgets.setBudgetAmount(client, writer, month, cat.id, amount);
      console.log(`Set ${categoryName} budget for ${month}: ${formatCurrency(amount)}`);
      break;
    }
    case 'set-carryover': {
      const month = requireFlag(flags, 'month');
      const categoryName = requireFlag(flags, 'category');
      const flag = requireFlag(flags, 'enabled') === 'true';
      const cat = await categories.findCategoryByName(client, categoryName);
      if (!cat) throw new Error(`Category not found: ${categoryName}`);
      await budgets.setBudgetCarryover(client, writer, month, cat.id, flag);
      console.log(`Carryover for ${categoryName} in ${month}: ${flag}`);
      break;
    }
    case 'transfer': {
      const month = requireFlag(flags, 'month');
      const fromName = requireFlag(flags, 'from');
      const toName = requireFlag(flags, 'to');
      const amount = amountToCents(parseFloat(requireFlag(flags, 'amount')));
      const fromCat = await categories.findCategoryByName(client, fromName);
      const toCat = await categories.findCategoryByName(client, toName);
      if (!fromCat) throw new Error(`Category not found: ${fromName}`);
      if (!toCat) throw new Error(`Category not found: ${toName}`);
      await budgets.transferBudget(client, writer, month, fromCat.id, toCat.id, amount);
      console.log(`Transferred ${formatCurrency(amount)} from "${fromName}" to "${toName}" in ${month}.`);
      break;
    }
    case 'income': {
      const month = requireFlag(flags, 'month');
      const income = await budgets.getIncomeForMonth(client, month);
      if (isJson(flags)) return printJson(income);
      console.log(`\nIncome for ${month}:`);
      console.log(`  ${'Category'.padEnd(22)} ${'Budgeted'.padStart(12)} ${'Received'.padStart(12)}`);
      console.log(`  ${'─'.repeat(48)}`);
      for (const c of income.categories) {
        console.log(`  ${c.name.padEnd(22)} ${formatCurrency(c.budgeted).padStart(12)} ${formatCurrency(c.received).padStart(12)}`);
      }
      console.log(`  ${'─'.repeat(48)}`);
      console.log(`  ${'Total'.padEnd(22)} ${formatCurrency(income.totalBudgeted).padStart(12)} ${formatCurrency(income.totalReceived).padStart(12)}`);
      break;
    }
    case 'summary': case 'totals': {
      const month = requireFlag(flags, 'month');
      const totals = await budgets.getTotalBudgeted(client, month);
      if (isJson(flags)) return printJson(totals);
      console.log(`\nBudget summary for ${month}:`);
      console.log(`  Total budgeted: ${formatCurrency(totals.totalBudgeted)}`);
      console.log(`  Total spent:    ${formatCurrency(totals.totalSpent)}`);
      console.log(`  Total balance:  ${formatCurrency(totals.totalBalance)}`);
      console.log(`  To budget:      ${formatCurrency(totals.toBudget)}`);
      break;
    }
    default:
      throw new Error(`Unknown budgets subcommand: ${sub}. Use: list, switch, months, month, set-amount, set-carryover, transfer, income, summary`);
  }
}

async function listBudgetCatalog(client: ActualClient) {
  await client.init();
  const files = await client.listBudgets();
  persistBudgetCatalog(files);

  return files.map(file => ({
    syncId: file.groupId,
    cloudFileId: file.cloudFileId,
    name: file.name,
    isEncrypted: !!file.encryptKeyId,
    hasSavedPassword: !!getBudgetPassword(file.groupId),
  }));
}

async function handleAuthCommand(sub: string, flags: Record<string, string>) {
  switch (sub) {
    case 'bootstrap': {
      const payload = parseInstallPayload(requireFlag(flags, 'payload'));
      saveBootstrapPayload(payload);
      console.log(`Bootstrapped ${payload.budgetName || payload.syncId}`);
      break;
    }
    default:
      throw new Error('Unknown auth subcommand: bootstrap');
  }
}

function handleConfigCommand(sub: string, flags: Record<string, string>) {
  switch (sub) {
    case 'show': {
      const config = getInstalledConfig();
      const redacted = {
        apiUrl: config.apiUrl,
        displayUrl: config.displayUrl,
        defaultSyncId: config.defaultSyncId,
        defaultBudgetName: config.defaultBudgetName,
        hasApiKey: !!config.apiKey,
        hasEncryptionPassword: !!config.encryptionPassword,
        budgets: Object.fromEntries(
          Object.entries(config.budgets ?? {}).map(([syncId, budget]) => [
            syncId,
            {
              syncId: budget.syncId ?? syncId,
              budgetName: budget.budgetName,
              isEncrypted: budget.isEncrypted,
              hasSavedPassword: !!budget.encryptionPassword || budget.hasSavedPassword === true,
            },
          ])
        ),
      };
      if (isJson(flags)) return printJson(redacted);
      console.log(JSON.stringify(redacted, null, 2));
      break;
    }
    default:
      throw new Error('Unknown config subcommand: show');
  }
}

async function handleQuery(client: ActualClient, sub: string, flags: Record<string, string>, positional: string[]) {
  const queryType = sub || getFlag(flags, 'type') || positional[0] || 'custom';
  switch (queryType) {
    case 'spending': {
      const spendMonth = requireFlag(flags, 'month');
      const summary = await queries.getSpendingSummary(client, spendMonth);
      if (isJson(flags)) return printJson(summary);
      ui.printSpendingSummary(summary, spendMonth);
      break;
    }
    case 'accounts': case 'summary': {
      const acctSummary = await queries.getAccountSummary(client);
      if (isJson(flags)) return printJson(acctSummary);
      ui.printAccounts(acctSummary as any);
      break;
    }
    case 'uncategorized': {
      const accountName = getFlag(flags, 'account');
      const accountId = accountName ? await accounts.resolveAccountId(client, accountName) : undefined;
      const txns = await queries.getUncategorizedTransactions(client, accountId);
      if (isJson(flags)) return printJson(txns);
      printTable(txns.slice(0, 50).map((t: any) => ({
        id: t.id?.slice(0, 8), date: t.date, payee: (t.payee_name || t.imported_payee || '').slice(0, 25),
        amount: formatCurrency(t.amount || 0), notes: (t.notes || '').slice(0, 30),
      })));
      console.log(`\nTotal uncategorized: ${txns.length}`);
      break;
    }
    case 'payee': {
      const txns = await queries.getTransactionsByPayee(client, requireFlag(flags, 'name'), parseInt(getFlag(flags, 'limit') || '20'));
      if (isJson(flags)) return printJson(txns);
      printTable(txns.map((t: any) => ({
        date: t.date, payee: t.payee_name || '', amount: formatCurrency(t.amount || 0), category: t.category_name || '',
      })));
      break;
    }
    case 'category': {
      const txns = await queries.getTransactionsByCategory(client, requireFlag(flags, 'name'), getFlag(flags, 'start'), getFlag(flags, 'end'));
      if (isJson(flags)) return printJson(txns);
      printTable(txns.map((t: any) => ({
        date: t.date, payee: t.payee_name || '', amount: formatCurrency(t.amount || 0), notes: (t.notes || '').slice(0, 30),
      })));
      break;
    }
    case 'trends': {
      const numMonths = parseInt(getFlag(flags, 'months') || '3');
      const trends = await queries.getSpendingTrends(client, numMonths);
      if (isJson(flags)) return printJson(trends);

      if (trends.length === 0) { console.log('No spending data.'); break; }
      const monthHeaders = trends[0].months.map(m => m.month.slice(2)); // YY-MM
      console.log(`\n  ${'Category'.padEnd(22)} ${monthHeaders.map(h => h.padStart(12)).join('')}`);
      console.log(`  ${'─'.repeat(22 + monthHeaders.length * 12)}`);
      for (const t of trends) {
        const vals = t.months.map(m => formatCurrency(m.spent).padStart(12)).join('');
        console.log(`  ${t.category.slice(0, 20).padEnd(22)} ${vals}`);
      }
      console.log('');
      break;
    }
    case 'top': case 'top-categories': {
      const topMonth = requireFlag(flags, 'month');
      const topLimit = parseInt(getFlag(flags, 'limit') || '10');
      const top = await queries.getTopCategories(client, topMonth, topLimit);
      if (isJson(flags)) return printJson(top);

      console.log(`\nTop spending categories — ${topMonth}:\n`);
      console.log(`  ${'#'.padStart(3)} ${'Category'.padEnd(22)} ${'Spent'.padStart(12)} ${'Budget'.padStart(12)} ${'%'.padStart(5)}`);
      console.log(`  ${'─'.repeat(56)}`);
      for (const c of top) {
        const bar = '█'.repeat(Math.round(c.pct / 5)) + '░'.repeat(20 - Math.round(c.pct / 5));
        console.log(`  ${String(c.rank).padStart(3)} ${c.category.slice(0, 20).padEnd(22)} ${formatCurrency(c.spent).padStart(12)} ${formatCurrency(c.budgeted).padStart(12)} ${String(c.pct + '%').padStart(5)}  ${bar}`);
      }
      console.log('');
      break;
    }
    case 'monthly': case 'monthly-totals': {
      const numM = parseInt(getFlag(flags, 'months') || '6');
      const totals = await queries.getMonthlyTotals(client, numM);
      if (isJson(flags)) return printJson(totals);

      console.log(`\nMonthly totals:\n`);
      console.log(`  ${'Month'.padEnd(10)} ${'Income'.padStart(12)} ${'Expenses'.padStart(12)} ${'Net'.padStart(12)}`);
      console.log(`  ${'─'.repeat(48)}`);
      for (const m of totals) {
        console.log(`  ${m.month.padEnd(10)} ${formatCurrency(m.income).padStart(12)} ${formatCurrency(m.expenses).padStart(12)} ${formatCurrency(m.net).padStart(12)}`);
      }
      console.log('');
      break;
    }
    case 'balance-history': {
      const accountName = requireFlag(flags, 'account');
      const accountId = await accounts.resolveAccountId(client, accountName);
      const numM = parseInt(getFlag(flags, 'months') || '6');
      const history = await queries.getBalanceHistory(client, accountId, numM);
      if (isJson(flags)) return printJson(history);

      const acctObj = await accounts.findAccountByName(client, accountName);
      console.log(`\nBalance history — ${acctObj?.name || accountName} (${history.length} days):\n`);
      console.log(`  ${'Date'.padEnd(12)} ${'Balance'.padStart(12)} ${'Change'.padStart(12)}`);
      console.log(`  ${'─'.repeat(38)}`);

      // Show sampled entries (every 7th day if too many)
      const step = history.length > 30 ? Math.ceil(history.length / 30) : 1;
      for (let i = 0; i < history.length; i += step) {
        const h = history[i];
        const chg = h.dailyChange !== 0 ? formatCurrency(h.dailyChange) : '';
        console.log(`  ${h.date.padEnd(12)} ${formatCurrency(h.balance).padStart(12)} ${chg.padStart(12)}`);
      }
      // Always show last entry
      if (history.length > 0 && (history.length - 1) % step !== 0) {
        const last = history[history.length - 1];
        console.log(`  ${last.date.padEnd(12)} ${formatCurrency(last.balance).padStart(12)} ${formatCurrency(last.dailyChange).padStart(12)}`);
      }
      console.log('');
      break;
    }
    case 'monthly-balances': {
      const accountName = requireFlag(flags, 'account');
      const accountId = await accounts.resolveAccountId(client, accountName);
      const numM = parseInt(getFlag(flags, 'months') || '12');
      const balances = await queries.getMonthlyBalances(client, accountId, numM);
      if (isJson(flags)) return printJson(balances);

      const acctObj = await accounts.findAccountByName(client, accountName);
      console.log(`\nMonthly balances — ${acctObj?.name || accountName}:\n`);
      console.log(`  ${'Month'.padEnd(10)} ${'Balance'.padStart(12)} ${'Change'.padStart(12)}  Chart`);
      console.log(`  ${'─'.repeat(50)}`);

      const maxBal = Math.max(...balances.map(b => Math.abs(b.balance)), 1);
      for (const b of balances) {
        const barLen = Math.round((Math.abs(b.balance) / maxBal) * 20);
        const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
        const chg = b.change !== 0 ? formatCurrency(b.change) : '';
        console.log(`  ${b.month.padEnd(10)} ${formatCurrency(b.balance).padStart(12)} ${chg.padStart(12)}  ${bar}`);
      }
      console.log('');
      break;
    }
    default: {
      const queryStr = positional[0] || getFlag(flags, 'q') || '';
      if (!queryStr) {
        console.log('Query types: spending, accounts, uncategorized, payee, category, trends, top, monthly, balance-history, monthly-balances');
        console.log('Usage: query <type> --flags  OR  query --q=\'{"json":"query"}\'');
        return;
      }
      printJson(await queries.runCustomQuery(client, JSON.parse(queryStr)));
    }
  }
}

export function printHelp() {
  ui.printHelp();
}

export async function launchUi() {
  await import('./tui/app.js');
}

async function handleSessionCommand(sub: string, flags: Record<string, string>) {
  switch (sub) {
    case 'start': {
      if (isDaemonRunning()) {
        const status = readStatus();
        const requestedBudget = getFlag(flags, 'budget');
        const sameBudget = !requestedBudget ||
          [status?.budgetRef, status?.budgetGroupId, status?.budgetName].includes(requestedBudget);
        if (sameBudget) {
          console.log(`Arc daemon already running (pid ${status?.pid}).`);
          return;
        }
        stopDaemonProcess();
      }
      startDaemonProcess(process.cwd(), getFlag(flags, 'budget'));
      const ready = await waitForDaemon(parseInt(getFlag(flags, 'timeout') || '15000', 10));
      if (!ready) throw new Error('Arc daemon did not become ready in time.');
      const status = readStatus();
      console.log(`Arc daemon started (pid ${status?.pid}).`);
      break;
    }
    case 'stop': {
      const stopped = stopDaemonProcess();
      console.log(stopped ? 'Arc daemon stopped.' : 'Arc daemon was not running.');
      break;
    }
    case 'status': {
      const status = readStatus();
      const running = isDaemonRunning();
      if (isJson(flags)) return printJson({ running, ...(status || {}) });
      if (!running) {
        console.log('Arc daemon not running.');
        return;
      }
      console.log(`Arc daemon running (pid ${status?.pid})`);
      console.log(`Socket: ${status?.socketPath}`);
      console.log(`Started: ${status?.startedAt}`);
      if (status?.budgetName || status?.budgetGroupId || status?.budgetRef) {
        console.log(`Budget: ${status?.budgetName || status?.budgetRef || status?.budgetGroupId}`);
      }
      break;
    }
    default:
      throw new Error('Unknown session subcommand: start, stop, status');
  }
}

export async function executeParsedCommand(
  parsed: ParsedArgs,
  client: ActualClient,
  writer: SafeWriter,
  uiLauncher: () => Promise<void> = launchUi
) {
  const { command, subcommand, flags, positional } = parsed;
  switch (command) {
    case 'ui': await uiLauncher(); break;
    case 'connect': await handleConnect(client, flags); break;
    case 'doctor': await handleDoctor(client, flags); break;
    case 'accounts': await handleAccounts(client, writer, subcommand, flags); break;
    case 'transactions': await handleTransactions(client, writer, subcommand, flags, positional); break;
    case 'categories': await handleCategories(client, writer, subcommand, flags); break;
    case 'payees': await handlePayees(client, writer, subcommand, flags); break;
    case 'tags': await handleTags(client, writer, subcommand, flags); break;
    case 'rules': await handleRules(client, writer, subcommand, flags, positional); break;
    case 'schedules': await handleSchedules(client, writer, subcommand, flags, positional); break;
    case 'budgets': await handleBudgets(client, writer, subcommand, flags); break;
    case 'query': await handleQuery(client, subcommand, flags, positional); break;
    default: console.error(`Unknown command: ${command}`); printHelp();
  }
}

// ── Main ──────────────────────────────────────────────────────

export async function main(
  argv: string[] = process.argv,
  uiLauncher: () => Promise<void> = launchUi,
  mcpLauncher: () => Promise<void> = startMcpServer
) {
  const { command, subcommand, flags, positional } = parseArgs(argv);

  if (command === 'help' || flags.help === 'true') { printHelp(); return; }

  if (command === 'backup') {
    const backup = new BackupManager();
    const sub = subcommand;
    if (sub === 'list') {
      ui.printBackups(backup.listBackups());
    } else if (sub === 'clean') {
      backup.cleanOldBackups(parseInt(getFlag(flags, 'keep') || '10'));
    }
    return;
  }

  if (command === 'session') {
    try {
      await handleSessionCommand(subcommand, flags);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'auth') {
    try {
      await handleAuthCommand(subcommand, flags);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'config') {
    try {
      handleConfigCommand(subcommand, flags);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'ui') {
    await executeParsedCommand({ command, subcommand, flags, positional }, {} as any, {} as any, uiLauncher);
    return;
  }

  if (command === 'mcp') {
    try {
      // `arc mcp --http` switches from stdio to a Streamable HTTP server
      // that Claude.ai (web + mobile) and Cursor's remote-MCP feature
      // can connect to over the network. Combine with cloudflare tunnel
      // / tailscale funnel / ngrok to reach it from a phone.
      const isHttp =
        getFlag(flags, 'http') !== undefined ||
        getFlag(flags, 'http') === '' ||
        flags.http === '' ||
        positional[0] === 'http' ||
        process.argv.includes('--http');
      if (isHttp) {
        const portFlag = getFlag(flags, 'port') || getFlag(flags, 'http-port');
        const port = portFlag ? Number.parseInt(portFlag, 10) : undefined;
        const host = getFlag(flags, 'host') || getFlag(flags, 'http-host');
        const token = getFlag(flags, 'token') || getFlag(flags, 'http-token') || process.env.ARC_MCP_HTTP_TOKEN;
        const path = getFlag(flags, 'path') || getFlag(flags, 'http-path');
        const handle = await startHttpMcpServer({ port, host, token, path });
        // Hold the process open until SIGINT/SIGTERM.
        const stop = async (signal: NodeJS.Signals) => {
          console.error(`\nReceived ${signal}, shutting down arc mcp http…`);
          await handle.close();
          process.exit(0);
        };
        process.on('SIGINT', () => { void stop('SIGINT'); });
        process.on('SIGTERM', () => { void stop('SIGTERM'); });
        // The HTTP server keeps the event loop alive on its own.
        return;
      }

      await mcpLauncher();
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    return;
  }

  const requestedBudget = getFlag(flags, 'budget') || process.env.ACTUAL_BUDGET_SYNC_ID;
  const daemonStatus = !process.env.ARC_DAEMON_CHILD && !process.env.ARC_DISABLE_DAEMON ? readStatus() : null;
  const daemonMatchesBudget = !daemonStatus
    ? true
    : !requestedBudget
      ? !daemonStatus.budgetRef && !daemonStatus.budgetGroupId && !daemonStatus.budgetName
      : [daemonStatus.budgetRef, daemonStatus.budgetGroupId, daemonStatus.budgetName].includes(requestedBudget);

  if (!process.env.ARC_DAEMON_CHILD && !process.env.ARC_DISABLE_DAEMON && isDaemonRunning() && daemonMatchesBudget) {
    try {
      const response = await sendDaemonRequest({ command, subcommand, flags, positional });
      if (response.stderr) process.stderr.write(`${response.stderr}\n`);
      if (response.stdout) process.stdout.write(`${response.stdout}\n`);
      if (!response.ok) {
        console.error(`Error: ${response.error}`);
        process.exit(1);
      }
      return;
    } catch {
      // Fall through to one-shot mode if the daemon is stale or unreachable.
    }
  }

  const client = ActualClient.fromEnv();

  // Override budget from --budget flag (takes precedence over .env)
  const budgetFlag = getFlag(flags, 'budget');
  if (budgetFlag && !(command === 'budgets' && subcommand === 'switch')) {
    client.selectBudget(budgetFlag);
  }

  // `files` command lists available budgets without loading one
  if (command === 'files') {
    try {
      await handleFiles(client, flags);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    } finally {
      try { await client.api.shutdown(); } catch {}
    }
    return;
  }

  if (command === 'budgets' && subcommand === 'list') {
    try {
      const catalog = await listBudgetCatalog(client);
      if (isJson(flags)) {
        printJson(catalog);
      } else {
        ui.printBudgetFiles(catalog.map(entry => ({
          groupId: entry.syncId,
          cloudFileId: entry.cloudFileId,
          name: entry.name,
          encryptKeyId: entry.isEncrypted ? 'encrypted' : undefined,
        })), client.getConfig().serverURL);
      }
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    } finally {
      try { await client.api.shutdown(); } catch {}
    }
    return;
  }

  if (command === 'budgets' && subcommand === 'switch') {
    try {
      await handleBudgets(client, {} as SafeWriter, subcommand, flags);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    } finally {
      try {
        await client.disconnect();
      } catch {
        try { await client.api.shutdown(); } catch {}
      }
    }
    return;
  }

  const backup = new BackupManager();
  const writer = new SafeWriter(client, backup);

  try {
    await client.connect();
    await executeParsedCommand({ command, subcommand, flags, positional }, client, writer, uiLauncher);
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  } finally {
    await client.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
