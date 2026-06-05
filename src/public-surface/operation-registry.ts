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

const jsonFlag = z
  .boolean()
  .optional()
  .describe("Return raw JSON instead of formatted output.");

// ── Registry ─────────────────────────────────────────────────────────────────

export const PUBLIC_OPERATIONS: readonly PublicOperation[] = [
  // ── accounts ──────────────────────────────────────────────────────────────
  {
    id: "accounts.list",
    group: "accounts",
    subcommand: "list",
    mcpTool: "arc_accounts_list",
    mode: "read",
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
    description: "Update fields on an existing transaction by id. Use `--add-tag` / `--remove-tag` to mutate `#tag` tokens in notes without rewriting the prose.",
    examples: [
      "arc transactions update --id <txn-id> --category 'Groceries' --notes 'Weekly run'",
      "arc transactions update --id <txn-id> --add-tag Quantini",
      "arc transactions update --id <txn-id> --remove-tag 'OldTag,Stale'",
    ],
    inputSchema: {
      id: z.string().describe("Transaction id (UUID)."),
      amount: amountNumber.optional(),
      date: dateStr.optional(),
      notes: z.string().optional(),
      cleared: z.boolean().optional(),
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
    description: "Delete a category, optionally transferring its transactions and budget to another category.",
    examples: ["arc categories delete --id 'Old' --transfer-to 'New'"],
    inputSchema: {
      id: categoryRef,
      transfer_to: categoryRef.optional(),
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
    description: "List investment accounts with their kind (stock/crypto), tracking mode (simple/detailed), data source, and value.",
    examples: ["arc portfolio accounts", "arc portfolio accounts --json"],
    inputSchema: { json: jsonFlag },
    defaultExposure: "default",
  },
];
