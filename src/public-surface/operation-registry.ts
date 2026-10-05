/**
 * Arc public operation registry.
 *
 * Single source of truth for the user-visible Arc CLI surface. Drives MCP
 * registration, doc/skill rendering, and CLI parity drift guards.
 *
 * Adding a CLI subcommand? Add an entry here too — `tests/cli-surface.test.ts`
 * (Task 5) will fail otherwise.
 *
 * Naming convention: inputSchema keys use snake_case (e.g. `transfer_to`,
 * `imported_id`) because MCP tool inputs are JSON and LLMs handle snake_case
 * more reliably than hyphenated keys. The CLI dispatcher still accepts the
 * legacy hyphenated flags (e.g. `--transfer-to`); Task 2 will translate
 * between MCP snake_case args and CLI hyphenated flags at the wiring layer.
 */

import { z } from "zod";
import type { PublicOperation } from "./registry-types.js";

// ── Reusable schema fragments ────────────────────────────────────────────────

const accountRef = z
  .string()
  .describe("Account name or UUID. Names are resolved case-insensitively.");

const categoryRef = z
  .string()
  .describe("Category name or UUID.");

const payeeRef = z
  .string()
  .describe("Payee name or UUID.");

const monthStr = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .describe("Budget month in YYYY-MM format.");

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("ISO date (YYYY-MM-DD).");

const amountNumber = z
  .number()
  .describe("Amount in major units (e.g. dollars). Negative for expenses.");

const goalRef = z
  .string()
  .describe("Goal name, its account name, or the account UUID.");

const jsonFlag = z
  .boolean()
  .optional()
  .describe("Return raw JSON instead of formatted output.");

const statementLine = z.object({
  date: dateStr,
  amount: amountNumber.describe(
    "Signed amount in major units from the account holder's side: negative = money out, positive = money in."
  ),
  payee: z.string().optional().describe("Merchant / counterparty as the bank prints it."),
  description: z.string().optional().describe("Free-text description or memo."),
  id: z.string().optional().describe("The bank's own id for the line (FITID / reference). Makes re-imports dedupe exactly."),
});

const statementSource = {
  account: accountRef,
  file: z
    .string()
    .optional()
    .describe("Path to a CSV or JSON statement on this machine. CSV needs a date column plus `amount` or `debit`/`credit`. Pass this or `lines`."),
  lines: z.array(statementLine).optional().describe("Statement lines inline. Pass this or `file`."),
  date_format: z
    .enum(["ymd", "dmy", "mdy"])
    .optional()
    .describe("How to read dates like 03/04/2026. Detected when the file makes it unambiguous."),
  invert: z.boolean().optional().describe("Flip every amount, for card statements that print purchases as positive."),
  window_days: z.number().int().min(0).max(10).optional().describe("Days a posting date may drift from the ledger date. Default 2."),
  opening_balance: amountNumber.optional().describe("Statement opening balance in major units, checked against the ledger the day before the first line."),
  closing_balance: amountNumber.optional().describe("Statement closing balance in major units, checked against the ledger on the last line's date."),
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const PUBLIC_OPERATIONS: readonly PublicOperation[] = [
  // ── accounts ──────────────────────────────────────────────────────────────
  {
    id: "accounts.list",
    group: "accounts",
    subcommand: "list",
    mcpTool: "arc_accounts_list",
    mode: "read",
    risk: "read",
    description: "List all accounts in the active budget with balances and on/off-budget status.",
    examples: ["arc accounts list", "arc accounts list --json"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "accounts.balance",
    group: "accounts",
    subcommand: "balance",
    mcpTool: "arc_accounts_balance",
    mode: "read",
    risk: "read",
    description: "Show the current balance of a single account.",
    examples: ["arc accounts balance --account 'HDFC Checking'"],
    inputSchema: {
      account: accountRef,
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "accounts.create",
    group: "accounts",
    subcommand: "create",
    mcpTool: "arc_accounts_create",
    mode: "write",
    risk: "write",
    description: "Create a new account, optionally off-budget and with a starting balance.",
    examples: [
      "arc accounts create --name 'Brokerage' --type investment --offbudget true",
      "arc accounts create --name 'Cash' --balance 200",
    ],
    inputSchema: {
      name: z.string().describe("Display name for the new account."),
      type: z.string().optional().describe("Account type (e.g. checking, savings, credit, investment)."),
      offbudget: z.boolean().optional().describe("Create as off-budget account."),
      balance: amountNumber.optional().describe("Initial balance in major units."),
    },
    defaultExposure: "default",
  },
  {
    id: "accounts.update",
    group: "accounts",
    subcommand: "update",
    mcpTool: "arc_accounts_update",
    mode: "write",
    risk: "write",
    description: "Update an account's name, type, or on/off-budget flag.",
    examples: ["arc accounts update --id 'Cash' --name 'Wallet'"],
    inputSchema: {
      id: accountRef,
      name: z.string().optional(),
      type: z.string().optional(),
      offbudget: z.boolean().optional(),
    },
    defaultExposure: "default",
  },
  {
    id: "accounts.close",
    group: "accounts",
    subcommand: "close",
    mcpTool: "arc_accounts_close",
    mode: "write",
    risk: "destructive",
    description: "Close an account, optionally transferring its remaining balance to another account.",
    examples: ["arc accounts close --id 'Old Card' --transfer-to 'New Card'"],
    inputSchema: {
      id: accountRef,
      transfer_to: accountRef.optional().describe("Account to receive the closing balance transfer."),
    },
    defaultExposure: "default",
  },
  {
    id: "accounts.reopen",
    group: "accounts",
    subcommand: "reopen",
    mcpTool: "arc_accounts_reopen",
    mode: "write",
    risk: "write",
    description: "Reopen a previously closed account.",
    examples: ["arc accounts reopen --id 'Old Card'"],
    inputSchema: { id: accountRef },
    defaultExposure: "default",
  },
  {
    id: "accounts.delete",
    group: "accounts",
    subcommand: "delete",
    mcpTool: "arc_accounts_delete",
    mode: "write",
    risk: "destructive",
    description: "Permanently delete an account. Destructive — prefer close in most cases.",
    examples: ["arc accounts delete --id 'Test Account'"],
    inputSchema: { id: accountRef },
    defaultExposure: "advanced",
  },

  // ── transactions ──────────────────────────────────────────────────────────
  {
    id: "transactions.list",
    group: "transactions",
    subcommand: "list",
    mcpTool: "arc_transactions_list",
    mode: "read",
    risk: "read",
    description: "List transactions for an account, optionally filtered by date range. Pass `--tag` to search across ALL accounts by tag (`--account` becomes optional and narrows results when set).",
    examples: [
      "arc transactions list --account 'HDFC Checking'",
      "arc transactions list --account 'Card' --start 2026-01-01 --end 2026-03-31",
      "arc transactions list --tag Quantini",
      "arc transactions list --tag 'Quantini,Shrine Global' --start 2026-04-01",
    ],
    inputSchema: {
      account: accountRef.optional(),
      start: dateStr.optional(),
      end: dateStr.optional(),
      tag: z.string().optional().describe("Comma-separated tag name(s). Multi-tag = AND match. Searches across all accounts unless --account is also set."),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "transactions.add",
    group: "transactions",
    subcommand: "add",
    mcpTool: "arc_transactions_add",
    mode: "write",
    risk: "write",
    description: "Add a single transaction to an account. Generates a deterministic imported_id when omitted.",
    examples: [
      "arc transactions add --account 'Card' --date 2026-04-10 --amount -25.50 --payee 'Coffee Shop' --category 'Dining'",
      "arc transactions add --account 'Card' --date 2026-04-10 --amount -25.50 --payee 'Quantini Lunch' --tag 'Quantini'",
    ],
    inputSchema: {
      account: accountRef,
      date: dateStr,
      amount: amountNumber,
      payee: payeeRef.optional(),
      category: categoryRef.optional(),
      notes: z.string().optional(),
      tag: z.string().optional().describe("Comma-separated tag name(s) to apply. New tags are created with auto-color."),
      cleared: z.boolean().optional(),
      imported_id: z.string().optional().describe("Override the generated dedupe id."),
    },
    defaultExposure: "default",
  },
  {
    id: "transactions.import",
    group: "transactions",
    subcommand: "import",
    mcpTool: "arc_transactions_import",
    mode: "write",
    risk: "write",
    description: "Bulk-import transactions into an account from a JSON array, with automatic de-duplication.",
    examples: [
      "arc transactions import --account 'Card' '[{\"date\":\"2026-04-01\",\"amount\":-1234,\"payee_name\":\"Amazon\"}]'",
    ],
    inputSchema: {
      account: accountRef,
      data: z.string().describe("JSON-encoded array of Actual transaction objects (amounts in cents)."),
    },
    defaultExposure: "default",
  },
  {
    id: "transactions.update",
    group: "transactions",
    subcommand: "update",
    mcpTool: "arc_transactions_update",
    mode: "write",
    risk: "write",
    description: "Update fields on an existing transaction by id. Use `--add-tag` / `--remove-tag` to mutate `#tag` tokens in notes without rewriting the prose.",
    examples: [
      "arc transactions update --id <txn-id> --category 'Groceries' --notes 'Weekly run'",
      "arc transactions update --id <txn-id> --add-tag Quantini",
      "arc transactions update --id <txn-id> --remove-tag 'OldTag,Stale'",
      "arc transactions update --id <txn-id> --status reconciled",
    ],
    inputSchema: {
      id: z.string().describe("Transaction id (UUID)."),
      amount: amountNumber.optional(),
      date: dateStr.optional(),
      notes: z.string().optional(),
      cleared: z.boolean().optional(),
      status: z.enum(["pending", "cleared", "reconciled"]).optional().describe("Three-state settlement: pending, cleared, or reconciled (locks the row, as a reconciliation does). Overrides `cleared`."),
      category: categoryRef.optional(),
      payee: payeeRef.optional(),
      "add-tag": z.string().optional().describe("Comma-separated tags to append to the transaction's notes."),
      "remove-tag": z.string().optional().describe("Comma-separated tags to strip from the transaction's notes."),
    },
    defaultExposure: "default",
  },
  {
    id: "transactions.delete",
    group: "transactions",
    subcommand: "delete",
    mcpTool: "arc_transactions_delete",
    mode: "write",
    risk: "destructive",
    description: "Delete a transaction by id.",
    examples: ["arc transactions delete --id <txn-id>"],
    inputSchema: { id: z.string() },
    defaultExposure: "default",
  },
  {
    id: "transactions.split",
    group: "transactions",
    subcommand: "split",
    mcpTool: "arc_transactions_split",
    mode: "write",
    risk: "write",
    description: "Create a split transaction with one or more child sub-transactions.",
    examples: [
      "arc transactions split --account 'Card' --date 2026-04-01 --payee 'Costco' --subs '[{\"amount\":-50,\"category\":\"Groceries\"},{\"amount\":-20,\"category\":\"Household\"}]'",
    ],
    inputSchema: {
      account: accountRef,
      date: dateStr,
      payee: payeeRef.optional(),
      notes: z.string().optional(),
      cleared: z.boolean().optional(),
      subs: z.string().describe("JSON array of {amount, category?, notes?, payee?, transfer_account?}."),
    },
    defaultExposure: "default",
  },
  {
    id: "transactions.transfer",
    group: "transactions",
    subcommand: "transfer",
    mcpTool: "arc_transactions_transfer",
    mode: "write",
    risk: "write",
    description: "Create a linked transfer between two accounts.",
    examples: [
      "arc transactions transfer --from 'Checking' --to 'Savings' --amount 500 --date 2026-04-10",
    ],
    inputSchema: {
      from: accountRef,
      to: accountRef,
      amount: amountNumber,
      date: dateStr,
      notes: z.string().optional(),
      cleared: z.boolean().optional(),
      foreign_amount: amountNumber.optional().describe("Destination amount when accounts have different currencies."),
    },
    defaultExposure: "default",
  },
  {
    id: "transactions.batch-update",
    group: "transactions",
    subcommand: "batch-update",
    mcpTool: "arc_transactions_batch_update",
    mode: "write",
    risk: "destructive",
    description: "Apply field updates to many transactions in one call. Accepts a JSON array of {id, ...fields}.",
    examples: [
      "arc transactions batch-update '[{\"id\":\"...\",\"category\":\"Dining\"},{\"id\":\"...\",\"notes\":\"vacation\"}]'",
    ],
    inputSchema: {
      data: z.string().describe("JSON array of {id, payee?, category?, notes?, amount?, date?, cleared?}."),
    },
    defaultExposure: "advanced",
  },
  {
    id: "transactions.batch-add",
    group: "transactions",
    subcommand: "batch-add",
    mcpTool: "arc_transactions_batch_add",
    mode: "write",
    risk: "destructive",
    description: "Bulk-add transactions to an account, resolving category names and generating imported_ids.",
    examples: [
      "arc transactions batch-add --account 'Card' '[{\"date\":\"2026-04-01\",\"amount\":-12.5,\"payee_name\":\"Bakery\"}]'",
    ],
    inputSchema: {
      account: accountRef,
      data: z.string().describe("JSON array of {date, amount, payee_name?, category?, notes?, cleared?}."),
    },
    defaultExposure: "advanced",
  },
  {
    id: "transactions.batch-categorize",
    group: "transactions",
    subcommand: "batch-categorize",
    mcpTool: "arc_transactions_batch_categorize",
    mode: "write",
    risk: "destructive",
    description: "Categorize all uncategorized transactions in an account whose payee matches a substring pattern.",
    examples: [
      "arc transactions batch-categorize --account 'Card' --payee 'starbucks' --category 'Dining'",
    ],
    inputSchema: {
      account: accountRef,
      payee: z.string().describe("Case-insensitive substring matched against payee names."),
      category: categoryRef,
      start: dateStr.optional(),
      end: dateStr.optional(),
    },
    defaultExposure: "advanced",
  },

  // ── categories ────────────────────────────────────────────────────────────
  {
    id: "categories.list",
    group: "categories",
    subcommand: "list",
    mcpTool: "arc_categories_list",
    mode: "read",
    risk: "read",
    description: "List all category groups and their categories.",
    examples: ["arc categories list", "arc categories list --json"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "categories.create",
    group: "categories",
    subcommand: "create",
    mcpTool: "arc_categories_create",
    mode: "write",
    risk: "write",
    description: "Create a new category inside an existing category group.",
    examples: ["arc categories create --name 'Coffee' --group 'Food'"],
    inputSchema: {
      name: z.string(),
      group: z.string().describe("Category group name or id."),
      income: z.boolean().optional().describe("Mark as an income category."),
    },
    defaultExposure: "default",
  },
  {
    id: "categories.update",
    group: "categories",
    subcommand: "update",
    mcpTool: "arc_categories_update",
    mode: "write",
    risk: "write",
    description: "Rename a category, move it to a different group, or toggle hidden.",
    examples: ["arc categories update --id 'Coffee' --group 'Dining'"],
    inputSchema: {
      id: categoryRef,
      name: z.string().optional(),
      group: z.string().optional(),
      hidden: z.boolean().optional(),
    },
    defaultExposure: "default",
  },
  {
    id: "categories.delete",
    group: "categories",
    subcommand: "delete",
    mcpTool: "arc_categories_delete",
    mode: "write",
    risk: "destructive",
    description: "Delete a category, optionally transferring its transactions and budget to another category.",
    examples: ["arc categories delete --id 'Old' --transfer-to 'New'"],
    inputSchema: {
      id: categoryRef,
      transfer_to: categoryRef.optional(),
    },
    defaultExposure: "advanced",
  },
  {
    id: "categories.templates",
    group: "categories",
    subcommand: "templates",
    mcpTool: "arc_categories_templates",
    mode: "read",
    risk: "read",
    description:
      "List categories whose note carries Actual budget templates (`#template` / `#goal`), with the sinking-fund savings target arc can edit and whether the note is editable from arc. Amounts are integer minor units.",
    examples: ["arc categories templates", "arc categories templates --json"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "categories.template-set",
    group: "categories",
    subcommand: "template-set",
    mcpTool: "arc_categories_template_set",
    mode: "write",
    risk: "write",
    description:
      "Set a sinking-fund savings target on a category: writes `#template <amount> by <YYYY-MM> [repeat every …]` plus a `#goal <amount>` line into the category note, exactly as the arc app's Savings target editor does. Other lines in the note are kept byte-for-byte. Refused when the note holds a template arc will not rewrite (prioritized, several sinking templates, or a non-sinking form) — edit those in Actual.",
    examples: [
      "arc categories template-set --category 'Gifts' --target 500 --by 2026-12 --repeat-months 12",
      "arc categories template-set --category 'Car insurance' --target 900 --by 2027-03",
    ],
    inputSchema: {
      category: categoryRef,
      target: amountNumber.describe("Amount to have saved by the target month, in major units (e.g. 500). Must be positive."),
      by: monthStr.describe("Month the money is needed by (YYYY-MM)."),
      repeat_months: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Repeat the target every N months after it falls due (12 = every year). Omit for a one-off target."),
      emit_goal: z
        .boolean()
        .optional()
        .describe("Also write the companion `#goal` line so Actual judges the category on its balance. Default true, as the app does."),
    },
    defaultExposure: "default",
  },
  {
    id: "categories.template-clear",
    group: "categories",
    subcommand: "template-clear",
    mcpTool: "arc_categories_template_clear",
    mode: "write",
    risk: "write",
    description:
      "Remove the sinking-fund savings target arc manages from a category note (its `#template … by` line and the `#goal` line directly beneath). Prose and every other directive are left byte-for-byte.",
    examples: ["arc categories template-clear --category 'Gifts'"],
    inputSchema: { category: categoryRef },
    defaultExposure: "default",
  },

  {
    id: "categories.group-create",
    group: "categories",
    subcommand: "group-create",
    mcpTool: "arc_categories_group_create",
    mode: "write",
    risk: "write",
    description: "Create a new category group.",
    examples: ["arc categories group-create --name 'Travel'", "arc categories group-create --name 'Side income' --income"],
    inputSchema: {
      name: z.string(),
      income: z.boolean().optional().describe("Make it an income group."),
    },
    defaultExposure: "default",
  },
  {
    id: "categories.group-update",
    group: "categories",
    subcommand: "group-update",
    mcpTool: "arc_categories_group_update",
    mode: "write",
    risk: "write",
    description: "Rename a category group or toggle it hidden.",
    examples: ["arc categories group-update --id 'Travel' --name 'Trips'"],
    inputSchema: {
      id: z.string().describe("Category group name or id (exact)."),
      name: z.string().optional(),
      hidden: z.boolean().optional(),
    },
    defaultExposure: "default",
  },
  {
    id: "categories.group-delete",
    group: "categories",
    subcommand: "group-delete",
    mcpTool: "arc_categories_group_delete",
    mode: "write",
    risk: "destructive",
    description: "Delete a category group and its categories, optionally moving their transactions and budget to a category in another group.",
    examples: ["arc categories group-delete --id 'Old group' --transfer-to 'Groceries'"],
    inputSchema: {
      id: z.string().describe("Category group name or id (exact)."),
      transfer_to: categoryRef.optional().describe("Category that receives the deleted categories' transactions and budget."),
    },
    defaultExposure: "advanced",
  },

  // ── payees ────────────────────────────────────────────────────────────────
  {
    id: "payees.list",
    group: "payees",
    subcommand: "list",
    mcpTool: "arc_payees_list",
    mode: "read",
    risk: "read",
    description: "List all payees. Pass --all to include hidden / system payees.",
    examples: ["arc payees list", "arc payees list --all"],
    inputSchema: {
      all: z.boolean().optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "payees.create",
    group: "payees",
    subcommand: "create",
    mcpTool: "arc_payees_create",
    mode: "write",
    risk: "write",
    description: "Create a new payee by name.",
    examples: ["arc payees create --name 'Local Bakery'"],
    inputSchema: { name: z.string() },
    defaultExposure: "default",
  },
  {
    id: "payees.update",
    group: "payees",
    subcommand: "update",
    mcpTool: "arc_payees_update",
    mode: "write",
    risk: "write",
    description: "Rename an existing payee.",
    examples: ["arc payees update --id 'Bakery' --name 'Local Bakery'"],
    inputSchema: {
      id: payeeRef,
      name: z.string().optional(),
    },
    defaultExposure: "default",
  },
  {
    id: "payees.delete",
    group: "payees",
    subcommand: "delete",
    mcpTool: "arc_payees_delete",
    mode: "write",
    risk: "destructive",
    description: "Delete a payee. Linked transactions become payee-less.",
    examples: ["arc payees delete --id 'Old Vendor'"],
    inputSchema: { id: payeeRef },
    defaultExposure: "advanced",
  },
  {
    id: "payees.merge",
    group: "payees",
    subcommand: "merge",
    mcpTool: "arc_payees_merge",
    mode: "write",
    risk: "destructive",
    description: "Merge one or more payees into a target payee. Comma-separated source list.",
    examples: ["arc payees merge --target 'Amazon' --merge 'AMZN,Amazon.com,Amzn Mktp'"],
    inputSchema: {
      target: payeeRef,
      merge: z.string().describe("Comma-separated list of payee names/ids to merge into target."),
    },
    defaultExposure: "advanced",
  },
  {
    id: "payees.find-or-create",
    group: "payees",
    subcommand: "find-or-create",
    mcpTool: "arc_payees_find_or_create",
    mode: "write",
    risk: "write",
    description: "Look up a payee by name and create it if missing. Returns the payee id.",
    examples: ["arc payees find-or-create --name 'Local Bakery'"],
    inputSchema: { name: z.string() },
    defaultExposure: "default",
  },
  {
    id: "payees.common",
    group: "payees",
    subcommand: "common",
    mcpTool: "arc_payees_common",
    mode: "read",
    risk: "read",
    description: "List the most frequently used payees, ordered by transaction count.",
    examples: ["arc payees common --limit 10"],
    inputSchema: {
      limit: z.number().int().positive().optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },

  // ── tags ──────────────────────────────────────────────────────────────────
  //
  // Tags in Actual Budget are first-class entities (id/name/color/description)
  // synced via the standard CRDT pipeline. Tag *membership* on a transaction
  // lives in the `notes` field as `#tagname` (or `#"With Spaces"`) — Actual's
  // native parsing convention. The CLI surfaces both: tag CRUD against the
  // tags table, and tag-aware filtering / mutation on transaction notes.
  {
    id: "tags.list",
    group: "tags",
    subcommand: "list",
    mcpTool: "arc_tags_list",
    mode: "read",
    risk: "read",
    description: "List all tags with their colors and optional descriptions.",
    examples: ["arc tags list", "arc tags list --json"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "tags.add",
    group: "tags",
    subcommand: "add",
    mcpTool: "arc_tags_add",
    mode: "write",
    risk: "write",
    description: "Create a new tag. The leading `#` is optional and stripped if present.",
    examples: [
      "arc tags add --name Quantini",
      "arc tags add --name 'Shrine Global' --color '#A855F7' --description 'Company expenses'",
    ],
    inputSchema: {
      name: z.string(),
      color: z.string().optional().describe("Hex color, e.g. #A855F7."),
      description: z.string().optional(),
    },
    defaultExposure: "default",
  },
  {
    id: "tags.update",
    group: "tags",
    subcommand: "update",
    mcpTool: "arc_tags_update",
    mode: "write",
    risk: "write",
    description: "Rename a tag, change its color, or update its description. `--id` accepts the tag name or its UUID.",
    examples: [
      "arc tags update --id Quantini --color '#FF6B6B'",
      "arc tags update --id Quantini --name QuantiniLabs",
    ],
    inputSchema: {
      id: z.string().describe("Tag name or UUID."),
      name: z.string().optional(),
      color: z.string().optional(),
      description: z.string().optional(),
    },
    defaultExposure: "default",
  },
  {
    id: "tags.delete",
    group: "tags",
    subcommand: "delete",
    mcpTool: "arc_tags_delete",
    mode: "write",
    risk: "destructive",
    description: "Soft-delete a tag from the tag library. Existing transactions retain the `#tag` text in their notes — you must remove those separately.",
    examples: ["arc tags delete --id Quantini"],
    inputSchema: { id: z.string().describe("Tag name or UUID.") },
    defaultExposure: "advanced",
  },
  {
    id: "tags.apply",
    group: "tags",
    subcommand: "apply",
    mcpTool: "arc_tags_apply",
    mode: "write",
    risk: "write",
    description: "Append one or more tags to a transaction's notes. Comma-separated for multi-tag. Idempotent.",
    examples: [
      "arc tags apply --transaction <tx-id> --tag Quantini",
      "arc tags apply --transaction <tx-id> --tag 'Quantini,Shrine Global'",
    ],
    inputSchema: {
      transaction: z.string().describe("Transaction UUID."),
      tag: z.string().describe("Tag name(s), comma-separated."),
    },
    defaultExposure: "default",
  },
  {
    id: "tags.unapply",
    group: "tags",
    subcommand: "unapply",
    mcpTool: "arc_tags_unapply",
    mode: "write",
    risk: "write",
    description: "Remove one or more `#tag` tokens from a transaction's notes.",
    examples: ["arc tags unapply --transaction <tx-id> --tag Quantini"],
    inputSchema: {
      transaction: z.string(),
      tag: z.string().describe("Tag name(s), comma-separated."),
    },
    defaultExposure: "default",
  },

  // ── rules ─────────────────────────────────────────────────────────────────
  {
    id: "rules.list",
    group: "rules",
    subcommand: "list",
    mcpTool: "arc_rules_list",
    mode: "read",
    risk: "read",
    description: "List all transaction rules in the active budget.",
    examples: ["arc rules list", "arc rules list --json"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "rules.create",
    group: "rules",
    subcommand: "create",
    mcpTool: "arc_rules_create",
    mode: "write",
    risk: "write",
    description: "Create a rule from a JSON payload. Account/category/payee names in conditions and actions are auto-resolved to ids.",
    examples: [
      "arc rules create '{\"stage\":\"pre\",\"conditionsOp\":\"and\",\"conditions\":[{\"field\":\"payee\",\"op\":\"is\",\"value\":\"Starbucks\"}],\"actions\":[{\"field\":\"category\",\"op\":\"set\",\"value\":\"Dining\"}]}'",
    ],
    inputSchema: {
      data: z.string().describe("JSON-encoded Actual rule object."),
    },
    defaultExposure: "default",
  },
  {
    id: "rules.update",
    group: "rules",
    subcommand: "update",
    mcpTool: "arc_rules_update",
    mode: "write",
    risk: "write",
    description: "Update an existing rule. The JSON payload must include the rule id.",
    examples: ["arc rules update '{\"id\":\"...\",\"actions\":[...]}'"],
    inputSchema: {
      data: z.string().describe("JSON-encoded Actual rule object including id."),
    },
    defaultExposure: "default",
  },
  {
    id: "rules.delete",
    group: "rules",
    subcommand: "delete",
    mcpTool: "arc_rules_delete",
    mode: "write",
    risk: "destructive",
    description: "Delete a rule by id.",
    examples: ["arc rules delete --id <rule-id>"],
    inputSchema: { id: z.string() },
    defaultExposure: "default",
  },

  // ── schedules ─────────────────────────────────────────────────────────────
  {
    id: "schedules.list",
    group: "schedules",
    subcommand: "list",
    mcpTool: "arc_schedules_list",
    mode: "read",
    risk: "read",
    description: "List all recurring schedules.",
    examples: ["arc schedules list"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "schedules.create",
    group: "schedules",
    subcommand: "create",
    mcpTool: "arc_schedules_create",
    mode: "write",
    risk: "write",
    description: "Create a recurring schedule from a JSON payload. Account/category/payee names are auto-resolved.",
    examples: [
      "arc schedules create '{\"name\":\"Rent\",\"account\":\"Checking\",\"payee\":\"Landlord\",\"amount\":-150000,\"date\":{\"start\":\"2026-05-01\",\"frequency\":\"monthly\"}}'",
    ],
    inputSchema: {
      data: z.string().describe("JSON-encoded Actual schedule object."),
    },
    defaultExposure: "default",
  },
  {
    id: "schedules.update",
    group: "schedules",
    subcommand: "update",
    mcpTool: "arc_schedules_update",
    mode: "write",
    risk: "write",
    description: "Update an existing schedule by id with a JSON payload of fields to change.",
    examples: ["arc schedules update --id <sched-id> '{\"amount\":-160000}'"],
    inputSchema: {
      id: z.string(),
      data: z.string().describe("JSON-encoded partial schedule fields."),
    },
    defaultExposure: "default",
  },
  {
    id: "schedules.delete",
    group: "schedules",
    subcommand: "delete",
    mcpTool: "arc_schedules_delete",
    mode: "write",
    risk: "destructive",
    description: "Delete a schedule by id.",
    examples: ["arc schedules delete --id <sched-id>"],
    inputSchema: { id: z.string() },
    defaultExposure: "default",
  },
  {
    id: "schedules.post",
    group: "schedules",
    subcommand: "post",
    mcpTool: "arc_schedules_post",
    mode: "write",
    risk: "write",
    description: "Materialize a schedule as a real transaction on the given date (defaults to next due date).",
    examples: [
      "arc schedules post --id <sched-id>",
      "arc schedules post --id <sched-id> --date 2026-05-01",
    ],
    inputSchema: {
      id: z.string(),
      date: dateStr.optional(),
    },
    defaultExposure: "default",
  },
  {
    id: "schedules.upcoming",
    group: "schedules",
    subcommand: "upcoming",
    mcpTool: "arc_schedules_upcoming",
    mode: "read",
    risk: "read",
    description: "List schedules sorted by next due date.",
    examples: ["arc schedules upcoming"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "schedules.complete",
    group: "schedules",
    subcommand: "complete",
    mcpTool: "arc_schedules_complete",
    mode: "write",
    risk: "write",
    description: "Mark a schedule as completed so it stops generating new occurrences.",
    examples: ["arc schedules complete --id <sched-id>"],
    inputSchema: { id: z.string() },
    defaultExposure: "default",
  },

  // ── budgets ───────────────────────────────────────────────────────────────
  {
    id: "budgets.list",
    group: "budgets",
    subcommand: "list",
    mcpTool: "arc_budgets_list",
    mode: "read",
    risk: "read",
    description: "List budget files available on the configured Actual server.",
    examples: ["arc budgets list", "arc budgets list --json"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "budgets.months",
    group: "budgets",
    subcommand: "months",
    mcpTool: "arc_budgets_months",
    mode: "read",
    risk: "read",
    description: "List the budget months Actual has data for.",
    examples: ["arc budgets months"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "budgets.month",
    group: "budgets",
    subcommand: "month",
    aliases: ["show"],
    mcpTool: "arc_budgets_month",
    mode: "read",
    risk: "read",
    description: "Show the full budget for a single month (categories, budgeted, spent, balance).",
    examples: ["arc budgets month --month 2026-04", "arc budgets show --month 2026-04"],
    inputSchema: {
      month: monthStr,
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "budgets.set-amount",
    group: "budgets",
    subcommand: "set-amount",
    mcpTool: "arc_budgets_set_amount",
    mode: "write",
    risk: "write",
    description: "Set the budgeted amount for a category in a given month.",
    examples: ["arc budgets set-amount --month 2026-04 --category 'Groceries' --amount 600"],
    inputSchema: {
      month: monthStr,
      category: categoryRef,
      amount: amountNumber,
    },
    defaultExposure: "default",
  },
  {
    id: "budgets.set-carryover",
    group: "budgets",
    subcommand: "set-carryover",
    mcpTool: "arc_budgets_set_carryover",
    mode: "write",
    risk: "write",
    description: "Enable or disable budget carryover (rollover) for a category in a given month.",
    examples: ["arc budgets set-carryover --month 2026-04 --category 'Travel' --enabled true"],
    inputSchema: {
      month: monthStr,
      category: categoryRef,
      enabled: z.boolean(),
    },
    defaultExposure: "default",
  },
  {
    id: "budgets.transfer",
    group: "budgets",
    subcommand: "transfer",
    mcpTool: "arc_budgets_transfer",
    mode: "write",
    risk: "write",
    description: "Move budgeted money between two categories within the same month.",
    examples: ["arc budgets transfer --month 2026-04 --from 'Dining' --to 'Groceries' --amount 50"],
    inputSchema: {
      month: monthStr,
      from: categoryRef,
      to: categoryRef,
      amount: amountNumber,
    },
    defaultExposure: "default",
  },
  {
    id: "budgets.income",
    group: "budgets",
    subcommand: "income",
    mcpTool: "arc_budgets_income",
    mode: "read",
    risk: "read",
    description: "Show income categories with budgeted vs received totals for a month.",
    examples: ["arc budgets income --month 2026-04"],
    inputSchema: {
      month: monthStr,
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "budgets.summary",
    group: "budgets",
    subcommand: "summary",
    aliases: ["totals"],
    mcpTool: "arc_budgets_summary",
    mode: "read",
    risk: "read",
    description: "Top-line totals for a month: total budgeted, spent, balance, and to-budget.",
    examples: ["arc budgets summary --month 2026-04", "arc budgets totals --month 2026-04"],
    inputSchema: {
      month: monthStr,
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "budgets.switch",
    group: "budgets",
    subcommand: "switch",
    mcpTool: "arc_budgets_switch",
    mode: "write",
    risk: "write",
    description: "Switch the active budget file for subsequent commands. Persists the selection in the credential store.",
    examples: ["arc budgets switch --budget 'Family Budget'"],
    inputSchema: {
      budget: z.string().describe("Budget name, sync id, or cloud file id."),
      password: z.string().optional().describe("Encryption password for end-to-end encrypted budgets."),
    },
    // Advanced: mutates global credential-store state across sessions, which
    // has broader blast radius than a single-budget write. Require opt-in.
    defaultExposure: "advanced",
  },

  // ── query / report ────────────────────────────────────────────────────────
  {
    id: "query.spending",
    group: "query",
    subcommand: "spending",
    mcpTool: "arc_query_spending",
    mode: "read",
    risk: "read",
    description: "Spending summary for a month broken down by category.",
    examples: ["arc query spending --month 2026-04"],
    inputSchema: {
      month: monthStr,
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "query.accounts",
    group: "query",
    subcommand: "accounts",
    aliases: ["summary"],
    mcpTool: "arc_query_accounts",
    mode: "read",
    risk: "read",
    description: "Account summary report with balances and on/off-budget grouping.",
    examples: ["arc query accounts", "arc query summary"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "query.uncategorized",
    group: "query",
    subcommand: "uncategorized",
    mcpTool: "arc_query_uncategorized",
    mode: "read",
    risk: "read",
    description: "List uncategorized transactions, optionally scoped to one account.",
    examples: ["arc query uncategorized", "arc query uncategorized --account 'Card'"],
    inputSchema: {
      account: accountRef.optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "query.payee",
    group: "query",
    subcommand: "payee",
    mcpTool: "arc_query_payee",
    mode: "read",
    risk: "read",
    description: "Recent transactions for a single payee across all accounts.",
    examples: ["arc query payee --name 'Amazon' --limit 50"],
    inputSchema: {
      name: z.string(),
      limit: z.number().int().positive().optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "query.category",
    group: "query",
    subcommand: "category",
    mcpTool: "arc_query_category",
    mode: "read",
    risk: "read",
    description: "Transactions in a single category, optionally filtered by date range.",
    examples: ["arc query category --name 'Groceries' --start 2026-01-01 --end 2026-03-31"],
    inputSchema: {
      name: categoryRef,
      start: dateStr.optional(),
      end: dateStr.optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "query.trends",
    group: "query",
    subcommand: "trends",
    mcpTool: "arc_query_trends",
    mode: "read",
    risk: "read",
    description: "Per-category spending trend over the last N months.",
    examples: ["arc query trends --months 6"],
    inputSchema: {
      months: z.number().int().positive().optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "query.top",
    group: "query",
    subcommand: "top",
    aliases: ["top-categories"],
    mcpTool: "arc_query_top",
    mode: "read",
    risk: "read",
    description: "Top spending categories for a month, ranked by amount spent.",
    examples: ["arc query top --month 2026-04 --limit 10"],
    inputSchema: {
      month: monthStr,
      limit: z.number().int().positive().optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "query.monthly",
    group: "query",
    subcommand: "monthly",
    aliases: ["monthly-totals"],
    mcpTool: "arc_query_monthly",
    mode: "read",
    risk: "read",
    description: "Income, expenses, and net totals per month for the last N months.",
    examples: ["arc query monthly --months 12", "arc query monthly-totals --months 6"],
    inputSchema: {
      months: z.number().int().positive().optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "query.balance-history",
    group: "query",
    subcommand: "balance-history",
    mcpTool: "arc_query_balance_history",
    mode: "read",
    risk: "read",
    description: "Daily running balance for an account over the last N months.",
    examples: ["arc query balance-history --account 'Checking' --months 6"],
    inputSchema: {
      account: accountRef,
      months: z.number().int().positive().optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "query.monthly-balances",
    group: "query",
    subcommand: "monthly-balances",
    mcpTool: "arc_query_monthly_balances",
    mode: "read",
    risk: "read",
    description: "End-of-month balance series for an account over the last N months.",
    examples: ["arc query monthly-balances --account 'Checking' --months 12"],
    inputSchema: {
      account: accountRef,
      months: z.number().int().positive().optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "query.custom",
    group: "query",
    subcommand: "custom",
    mcpTool: "arc_query_custom",
    mode: "read",
    risk: "read",
    description: "Run a raw Actual query (ActualQL JSON). Advanced — for power users only.",
    examples: ["arc query custom --q '{\"table\":\"transactions\",\"select\":[\"id\",\"amount\"]}'"],
    inputSchema: {
      q: z.string().describe("JSON-encoded ActualQL query."),
    },
    defaultExposure: "advanced",
  },

  // ── portfolio (read-only investment views) ──────────────────────────────────
  {
    id: "portfolio.list",
    group: "portfolio",
    subcommand: "list",
    mcpTool: "arc_portfolio_list",
    mode: "read",
    risk: "read",
    description: "List holdings across all detailed investment accounts (symbol, asset class, quantity, price, value, unrealized P/L %).",
    examples: ["arc portfolio list", "arc portfolio list --account 'IBKR' --json"],
    inputSchema: {
      account: accountRef.optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "portfolio.holding",
    group: "portfolio",
    subcommand: "holding",
    mcpTool: "arc_portfolio_holding",
    mode: "read",
    risk: "read",
    description: "Detail for one holding — quantity, price, average cost, market value, unrealized P/L, allocation %, plus its trade ledger.",
    examples: ["arc portfolio holding --symbol AAPL", "arc portfolio holding --symbol SOL --account 'Crypto'"],
    inputSchema: {
      symbol: z.string().describe("Holding symbol (case-insensitive)."),
      account: accountRef.optional(),
    },
    defaultExposure: "default",
  },
  {
    id: "portfolio.trades",
    group: "portfolio",
    subcommand: "trades",
    mcpTool: "arc_portfolio_trades",
    mode: "read",
    risk: "read",
    description: "Trade / activity ledger (buys, sells, fees, dividends, …) across investment accounts and their paired cash accounts.",
    examples: ["arc portfolio trades --symbol AAPL", "arc portfolio trades --kind dividend --start 2026-01-01 --json"],
    inputSchema: {
      symbol: z.string().optional().describe("Filter by symbol (case-insensitive substring of the note's leading token)."),
      account: accountRef.optional(),
      kind: z
        .enum([
          "buy", "sell", "commission", "fee", "tax",
          "realized", "dividend", "interest", "deposit", "withdrawal", "other",
        ])
        .optional()
        .describe("Filter by activity kind."),
      start: dateStr.optional(),
      end: dateStr.optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "portfolio.summary",
    group: "portfolio",
    subcommand: "summary",
    mcpTool: "arc_portfolio_summary",
    mode: "read",
    risk: "read",
    description: "Portfolio totals — total market value, total unrealized P/L, and allocation by account and by asset class.",
    examples: ["arc portfolio summary", "arc portfolio summary --json"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "portfolio.accounts",
    group: "portfolio",
    subcommand: "accounts",
    mcpTool: "arc_portfolio_accounts",
    mode: "read",
    risk: "read",
    description: "List investment accounts with their kind (stock/crypto), tracking mode (simple/detailed), data source, and value.",
    examples: ["arc portfolio accounts", "arc portfolio accounts --json"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },

  {
    id: "portfolio.realized",
    group: "portfolio",
    subcommand: "realized",
    mcpTool: "arc_portfolio_realized",
    mode: "read",
    risk: "read",
    description: "Realized P/L from the app's closed-trade history (#trades:v1 notes) — win/loss stats, profit factor, and net realized by symbol, by month or year, and by account.",
    examples: ["arc portfolio realized", "arc portfolio realized --from 2026-01-01 --period year --json"],
    inputSchema: {
      account: accountRef.optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
      period: z.enum(["month", "year"]).optional().describe("Bucket size for the by-period breakdown (default month)."),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "portfolio.dividends",
    group: "portfolio",
    subcommand: "dividends",
    mcpTool: "arc_portfolio_dividends",
    mode: "read",
    risk: "read",
    description: "Dividends received, from the app's dividend history (#divs:v1 notes) — every payment plus totals by symbol, by year, and by account.",
    examples: ["arc portfolio dividends", "arc portfolio dividends --from 2026-01-01 --to 2026-12-31 --json"],
    inputSchema: {
      account: accountRef.optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "portfolio.history",
    group: "portfolio",
    subcommand: "history",
    mcpTool: "arc_portfolio_history",
    mode: "read",
    risk: "read",
    description: "Daily portfolio value series from the app's month-sharded position history (#pfhist:v1 notes), summed across accounts, with per-account latest value and top movers.",
    examples: ["arc portfolio history", "arc portfolio history --account 'IBKR' --from 2026-06-01 --json"],
    inputSchema: {
      account: accountRef.optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },

  // ── goals ──────────────────────────────────────────────────────────────────
  {
    id: "goals.list",
    group: "goals",
    subcommand: "list",
    mcpTool: "arc_goals_list",
    mode: "read",
    risk: "read",
    description:
      "List savings goals with funded amount, target, percent complete, and status (on_track / behind / ahead / completed / overdue).",
    examples: ["arc goals list", "arc goals list --archived --json"],
    inputSchema: {
      archived: z
        .boolean()
        .optional()
        .describe("Include archived goals. Archived goals are hidden by default."),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "goals.show",
    group: "goals",
    subcommand: "show",
    mcpTool: "arc_goals_show",
    mode: "read",
    risk: "read",
    description:
      "Full progress for one goal: funded, remaining, days and months left, and the monthly amount needed to stay on track.",
    examples: ["arc goals show --goal 'Japan trip'", "arc goals show --goal 'Japan trip' --json"],
    inputSchema: {
      goal: goalRef,
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "goals.create",
    group: "goals",
    subcommand: "create",
    mcpTool: "arc_goals_create",
    mode: "write",
    risk: "write",
    description:
      "Turn an existing account into a savings goal. Writes a `#goal:` tag onto the account note, so the goal shows up in the arc app too.",
    examples: [
      "arc goals create --account 'Savings' --target 5000 --deadline 2027-03-01",
      "arc goals create --account 'Savings' --name 'Japan trip' --target 5000 --behavior set_aside",
    ],
    inputSchema: {
      account: accountRef,
      name: z.string().optional().describe("Goal name. Defaults to the account name."),
      target: amountNumber.describe("Target amount in major units (e.g. 5000 for 5,000)."),
      deadline: dateStr.optional().describe("Target date (YYYY-MM-DD). Optional."),
      behavior: z
        .enum(["set_aside", "have_balance"])
        .optional()
        .describe(
          "have_balance (default) measures progress by the account's live balance. set_aside tracks contributions you record explicitly."
        ),
      color: z.string().optional().describe("Hex color, e.g. #00D632."),
      icon: z.string().optional().describe("Icon name, e.g. airplane."),
      current: z.boolean().optional().describe("Spotlight this as the current goal."),
    },
    defaultExposure: "default",
  },
  {
    id: "goals.update",
    group: "goals",
    subcommand: "update",
    mcpTool: "arc_goals_update",
    mode: "write",
    risk: "write",
    description: "Change a goal's name, target, deadline, behavior, color, or icon.",
    examples: [
      "arc goals update --goal 'Japan trip' --target 6000",
      "arc goals update --goal 'Japan trip' --deadline 2027-06-01",
    ],
    inputSchema: {
      goal: goalRef,
      name: z.string().optional(),
      target: amountNumber.optional(),
      deadline: z
        .string()
        .optional()
        .describe("ISO date (YYYY-MM-DD), or an empty string to clear the deadline."),
      behavior: z.enum(["set_aside", "have_balance"]).optional(),
      color: z.string().optional(),
      icon: z.string().optional(),
    },
    defaultExposure: "default",
  },
  {
    id: "goals.contribute",
    group: "goals",
    subcommand: "contribute",
    mcpTool: "arc_goals_contribute",
    mode: "write",
    risk: "write",
    description:
      "Record a contribution against a set-aside goal. Rejected for have-balance goals, which measure the account balance directly — add a transaction to the account instead.",
    examples: ["arc goals contribute --goal 'Japan trip' --amount 250"],
    inputSchema: {
      goal: goalRef,
      amount: amountNumber.describe("Amount to add, in major units. Negative to correct an overshoot."),
    },
    defaultExposure: "default",
  },
  {
    id: "goals.current",
    group: "goals",
    subcommand: "current",
    mcpTool: "arc_goals_current",
    mode: "write",
    risk: "write",
    description:
      "Spotlight one goal as the current goal, or clear the spotlight. At most one goal is current at a time.",
    examples: ["arc goals current --goal 'Japan trip'", "arc goals current --clear"],
    inputSchema: {
      goal: goalRef.optional(),
      clear: z.boolean().optional().describe("Clear the spotlight instead of setting it."),
    },
    defaultExposure: "default",
  },
  {
    id: "goals.archive",
    group: "goals",
    subcommand: "archive",
    mcpTool: "arc_goals_archive",
    mode: "write",
    risk: "write",
    description:
      "Archive a goal. It stops appearing in `goals list` but keeps its data, and loses the current-goal spotlight.",
    examples: ["arc goals archive --goal 'Japan trip'"],
    inputSchema: { goal: goalRef },
    defaultExposure: "default",
  },
  {
    id: "goals.reopen",
    group: "goals",
    subcommand: "reopen",
    mcpTool: "arc_goals_reopen",
    mode: "write",
    risk: "write",
    description: "Un-archive a goal.",
    examples: ["arc goals reopen --goal 'Japan trip'"],
    inputSchema: { goal: goalRef },
    defaultExposure: "default",
  },
  {
    id: "goals.delete",
    group: "goals",
    subcommand: "delete",
    mcpTool: "arc_goals_delete",
    mode: "write",
    risk: "destructive",
    description:
      "Remove the goal overlay from an account. The account, its balance and its transactions are left untouched.",
    examples: ["arc goals delete --goal 'Japan trip'"],
    inputSchema: { goal: goalRef },
    defaultExposure: "advanced",
  },

  // ── debts ─────────────────────────────────────────────────────────────────
  {
    id: "debts.list",
    group: "debts",
    subcommand: "list",
    mcpTool: "arc_debts_list",
    mode: "read",
    risk: "read",
    description:
      "List accounts marked as debts (credit cards, loans, EMIs) with their monthly due day, days until the next due date, and current balance. Soonest due first.",
    examples: ["arc debts list", "arc debts list --json"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "debts.set",
    group: "debts",
    subcommand: "set",
    mcpTool: "arc_debts_set",
    mode: "write",
    risk: "write",
    description:
      "Mark an account as a debt with a monthly payment due day, or change its due day. Writes `#debt|due:N` into the account note (other note content is kept); the arc app uses it for payment reminders.",
    examples: [
      "arc debts set --account 'Amex' --due 15",
      "arc debts set --account 'Car loan' --due 5",
    ],
    inputSchema: {
      account: accountRef,
      due: z.number().int().min(1).max(31).describe("Day of the month the payment is due, 1-31."),
    },
    defaultExposure: "default",
  },
  {
    id: "debts.clear",
    group: "debts",
    subcommand: "clear",
    mcpTool: "arc_debts_clear",
    mode: "write",
    risk: "write",
    description:
      "Stop treating an account as a debt: removes the `#debt|` line from its note. The account, its balance and its transactions are untouched.",
    examples: ["arc debts clear --account 'Amex'"],
    inputSchema: { account: accountRef },
    defaultExposure: "default",
  },

  // ── splits ─────────────────────────────────────────────────────────────────
  {
    id: "splits.list",
    group: "splits",
    subcommand: "list",
    mcpTool: "arc_splits_list",
    mode: "read",
    risk: "read",
    description:
      "List group splits, one entry per split event, with each person's share, what they owe, and whether they have settled.",
    examples: ["arc splits list", "arc splits list --person Sam --open --json"],
    inputSchema: {
      person: z.string().optional().describe("Only splits involving this person."),
      open: z.boolean().optional().describe("Only splits with something still owed."),
      start: dateStr.optional(),
      end: dateStr.optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "splits.balances",
    group: "splits",
    subcommand: "balances",
    mcpTool: "arc_splits_balances",
    mode: "read",
    risk: "read",
    description:
      "Who owes you what. Totals each person's outstanding and already-settled amounts across every split.",
    examples: ["arc splits balances", "arc splits balances --json"],
    inputSchema: { start: dateStr.optional(), end: dateStr.optional(), json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "splits.create",
    group: "splits",
    subcommand: "create",
    mcpTool: "arc_splits_create",
    mode: "write",
    risk: "write",
    description:
      "Share a transaction with one or more people. Four modes: equal, percent, exact, shares. Records what each person owes without moving any money.",
    examples: [
      "arc splits create --transaction <id> --people 'Sam,Kim' --mode equal --include-self",
      "arc splits create --transaction <id> --people 'Sam,Kim' --mode percent --values '60,40'",
    ],
    inputSchema: {
      transaction: z.string().describe("Transaction UUID to split."),
      people: z
        .array(z.string())
        .describe("People who owe you a share. Does not include you."),
      mode: z
        .enum(["equal", "percent", "exact", "shares"])
        .describe(
          "equal splits evenly; percent takes 0-100 per person; exact takes minor units per person; shares takes relative weights."
        ),
      values: z
        .array(z.number())
        .optional()
        .describe("One value per person, positional. Required for percent, exact and shares."),
      include_self: z
        .boolean()
        .optional()
        .describe(
          "Whether you are also sharing the cost. Changes an equal split from n ways to n+1."
        ),
    },
    defaultExposure: "default",
  },
  {
    id: "splits.settle",
    group: "splits",
    subcommand: "settle",
    mcpTool: "arc_splits_settle",
    mode: "write",
    risk: "write",
    description:
      "Mark one person's share as paid, optionally linking the repayment transaction so analytics can exclude it from income.",
    examples: [
      "arc splits settle --gid ab12cd --person Sam",
      "arc splits settle --gid ab12cd --person Sam --transaction <repayment-id>",
    ],
    inputSchema: {
      gid: z.string().describe("Split group id, from `arc splits list`."),
      person: z.string(),
      transaction: z.string().optional().describe("The repayment transaction's UUID."),
    },
    defaultExposure: "default",
  },
  {
    id: "splits.reopen",
    group: "splits",
    subcommand: "reopen",
    mcpTool: "arc_splits_reopen",
    mode: "write",
    risk: "write",
    description: "Flip a settled share back to open.",
    examples: ["arc splits reopen --gid ab12cd --person Sam"],
    inputSchema: { gid: z.string(), person: z.string() },
    defaultExposure: "default",
  },
  {
    id: "splits.remove",
    group: "splits",
    subcommand: "remove",
    mcpTool: "arc_splits_remove",
    mode: "write",
    risk: "destructive",
    description: "Drop one person from a split, leaving everyone else in it.",
    examples: ["arc splits remove --gid ab12cd --person Sam"],
    inputSchema: { gid: z.string(), person: z.string() },
    defaultExposure: "default",
  },
  {
    id: "splits.delete",
    group: "splits",
    subcommand: "delete",
    mcpTool: "arc_splits_delete",
    mode: "write",
    risk: "destructive",
    description:
      "Delete an entire split group across every transaction carrying it. The transactions themselves are untouched.",
    examples: ["arc splits delete --gid ab12cd"],
    inputSchema: { gid: z.string() },
    defaultExposure: "advanced",
  },
  // ── transactions: refunds ──────────────────────────────────────────────────
  {
    id: "transactions.refund",
    group: "transactions",
    subcommand: "refund",
    mcpTool: "arc_transactions_refund",
    mode: "write",
    risk: "write",
    description:
      "Mark a transaction refunded: zeroes its amount and records the original in a `#refund` note token, so the row stays visible instead of being deleted. Refuses transfers, splits and reconciled rows.",
    examples: ["arc transactions refund --id <transaction-id>"],
    inputSchema: { id: z.string().describe("Transaction UUID.") },
    defaultExposure: "default",
  },
  {
    id: "transactions.unrefund",
    group: "transactions",
    subcommand: "unrefund",
    mcpTool: "arc_transactions_unrefund",
    mode: "write",
    risk: "write",
    description:
      "Undo a refund, restoring the original amount, its direction (expense or income), and the note.",
    examples: ["arc transactions unrefund --id <transaction-id>"],
    inputSchema: { id: z.string().describe("Transaction UUID.") },
    defaultExposure: "default",
  },
  {
    id: "transactions.refunds",
    group: "transactions",
    subcommand: "refunds",
    mcpTool: "arc_transactions_refunds",
    mode: "read",
    risk: "read",
    description:
      "List refunded transactions with the original amount recovered from the refund token, and when each was marked.",
    examples: ["arc transactions refunds", "arc transactions refunds --start 2026-01-01 --json"],
    inputSchema: {
      account: accountRef.optional(),
      start: dateStr.optional(),
      end: dateStr.optional(),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },

  // ── reconcile (statement ↔ ledger) ───────────────────────────────────────────
  {
    id: "reconcile.statement",
    group: "reconcile",
    subcommand: "statement",
    mcpTool: "arc_reconcile_statement",
    mode: "read",
    risk: "read",
    description:
      "Compare a bank statement against an account. Each line comes back matched (exact, or a fuzzy merchant/date match), missing from the ledger, an amount mismatch, or ambiguous, and ledger rows in the statement's date range that no line explains come back as extra. Optionally checks the opening and closing balances. Changes nothing.",
    examples: [
      "arc reconcile statement --account 'Chase Checking' --file ~/Downloads/may.csv",
      "arc reconcile statement --account 'Amex' --file may.csv --invert --closing-balance -1243.18 --json",
    ],
    inputSchema: { ...statementSource, json: jsonFlag },
    defaultExposure: "default",
  },
  {
    id: "reconcile.apply",
    group: "reconcile",
    subcommand: "apply",
    mcpTool: "arc_reconcile_apply",
    mode: "write",
    risk: "destructive",
    description:
      "Apply a statement: import the lines the ledger is missing (cleared, with a deterministic imported_id so a re-run adds nothing) and mark matched transactions cleared. Amount mismatches and ambiguous matches are reported and left alone. Run `arc reconcile statement` first to see what it will do.",
    examples: [
      "arc reconcile apply --account 'Chase Checking' --file ~/Downloads/may.csv",
    ],
    inputSchema: { ...statementSource, json: jsonFlag },
    defaultExposure: "advanced",
  },
  {
    id: "transactions.duplicates",
    group: "transactions",
    subcommand: "duplicates",
    mcpTool: "arc_transactions_duplicates",
    mode: "read",
    risk: "read",
    description:
      "Find transactions that look like the same purchase recorded twice: same account, same sign, dated within a couple of days, with a matching amount and merchant (or an FX estimate next to the bank's posting). Returns groups with a 0-100 score and the reasons. Transfers and split legs are never flagged.",
    examples: [
      "arc transactions duplicates",
      "arc transactions duplicates --account 'Chase Checking' --since 2026-01-01 --json",
    ],
    inputSchema: {
      account: accountRef.optional(),
      since: dateStr.optional().describe("Only look at transactions on or after this date. Default: 90 days ago."),
      window_days: z.number().int().min(0).max(10).optional().describe("Max days apart for two rows to pair. Default 2."),
      min_score: z.number().min(0).max(100).optional().describe("Drop groups scoring below this. Default 60."),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },
  {
    id: "accounts.reconcile",
    group: "accounts",
    subcommand: "reconcile",
    mcpTool: "arc_accounts_reconcile",
    mode: "write",
    risk: "destructive",
    description:
      "Reconcile an account against the bank balance, as Actual's 'Done reconciling' does. Refuses, writing nothing, while the cleared balance differs from the bank and reports the difference. Once they agree, it locks every cleared transaction as reconciled and stamps the account's last-reconciled time.",
    examples: [
      "arc accounts reconcile --account 'Chase Checking' --balance 1240.55",
      "arc accounts reconcile --account 'Amex' --balance -812.40 --date 2026-05-31",
    ],
    inputSchema: {
      account: accountRef,
      balance: amountNumber.describe("The balance the bank shows, in major units. Negative for money owed on a card."),
      date: dateStr.optional().describe("Statement date: only cleared transactions on or before it count and get locked."),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },

  // ── server ─────────────────────────────────────────────────────────────────
  {
    id: "server.wake",
    group: "server",
    subcommand: "wake",
    mcpTool: "arc_server_wake",
    mode: "read",
    risk: "read",
    description:
      "Start a sleeping server and wait until it answers. Managed Arc servers scale to zero, so the first call after an idle period pays a cold start. Every other tool absorbs this automatically — call this first when you would rather pay the wait in one cheap request than risk it landing on a slow one.",
    examples: ["arc server wake", "arc server wake --timeout 120 --json"],
    inputSchema: {
      timeout: z
        .number()
        .optional()
        .describe("Seconds to wait before giving up. Defaults to 90."),
      json: jsonFlag,
    },
    defaultExposure: "default",
  },

  // ── agent ──────────────────────────────────────────────────────────────────
  // How an agent finds out what it may do, and finishes a call that waited
  // for approval. Never gated, never able to approve or deny anything: those
  // need the user's Face ID or Touch ID.
  {
    id: "agent.request-status",
    group: "agent",
    subcommand: "request-status",
    mcpTool: "arc_agent_request_status",
    mode: "read",
    risk: "read",
    description:
      "Finish a call that returned `pending_approval`. Waits up to `wait_seconds` for the user to decide, then runs the exact call they approved, once, and returns its result. Returns `pending_approval` again if they have not decided yet, or an error if they denied it or it expired.",
    examples: [
      "arc agent request-status --request-id k57abc --wait-seconds 30",
    ],
    inputSchema: {
      request_id: z.string().describe("The `request_id` from a `pending_approval` result."),
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe("Seconds to wait for a decision before returning (0-50). Defaults to 30."),
    },
    defaultExposure: "default",
  },
  {
    id: "agent.permissions",
    group: "agent",
    subcommand: "permissions",
    mcpTool: "arc_agent_permissions",
    mode: "read",
    risk: "read",
    description:
      "What this agent may do on this machine: for each operation group, whether reads, writes and deletes run, ask the user first, or are refused, plus any time-limited approvals in force. Call it before a batch of changes so you can tell the user what will need their approval.",
    examples: ["arc agent permissions", "arc agent permissions --json"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
];
