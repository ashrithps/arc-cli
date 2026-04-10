---
name: arc
description: "Use Arc to work with Actual budgets across accounts, transactions, categories, payees, rules, schedules, budget months, and reports. Supports multi-budget switching, the TUI, and MCP tooling."
---

<!--
⚠️  GENERATED FILE — do not edit directly.

This SKILL.md is produced by scripts/publish-public.sh in arc-cli-source.
Any hand edits here will be overwritten on the next publish.

Hand content lives in the heredoc template inside publish-public.sh.
The operation catalog between BEGIN:ARC_OPERATIONS_SKILL and
END:ARC_OPERATIONS_SKILL markers is generated from the registry at
src/public-surface/operation-registry.ts.
-->

# Arc CLI

Use `arc` for all Actual Budget work. The installed command is `arc`, not `arctual`.

Arc exposes the same operations three ways:

- as `arc <group> <subcommand>` on the command line
- as stdio MCP tools via `arc mcp` (one tool per operation)
- inside the TUI via `arc ui`

Prefer the MCP tools when driving Arc from an agent — inputs are schema-validated and errors are structured.

## Multi-Budget Behavior

- `arc budgets list` discovers every budget file on the configured Actual server.
- `arc budgets switch --budget <id>` changes the installed default budget. The selection persists in the credential store across sessions.
- Most commands also accept `--budget <id>` to run against a non-default budget without switching.

## Encrypted Budget Switching

- Encrypted budgets require `--password '<pw>'` the first time you switch to them.
- After a successful unlock Arc caches the password per budget in the credential store, so subsequent `arc budgets switch` calls are silent.
- `arc budgets switch` is marked _advanced_ in the operation catalog because it mutates global credential-store state that persists across sessions.

## Installed Runtime

- Installed config: `~/.arc-cli/config.json`
- Installed app snapshot: `~/.arc-cli/app`
- Launcher: `~/.local/bin/arc`
- `arc config show --json` prints the installed config summary with secrets redacted.
- `arc ui` launches the TUI; `arc mcp` starts the stdio MCP server.

## Operations Catalog

<!-- BEGIN:ARC_OPERATIONS_SKILL -->
<!-- Generated from src/public-surface/operation-registry.ts. Do not edit by hand. -->

Arc's data-operation surface is exposed identically through the CLI and through `arc mcp` (stdio MCP server). Every operation below is available as both `arc <group> <subcommand>` on the command line and as an MCP tool named `arc_<group>_<subcommand>`. Prefer the MCP tools from inside agents — argument validation and error messages are structured.

Each entry is tagged with its mode (`read` or `write`) and exposure tier. Tools tagged `(advanced)` are batch, destructive, or global-state operations; treat them as opt-in and double-check inputs before calling.

## Accounts

Manage on- and off-budget accounts and balances.

### `arc accounts list`

- mode: **read**
- mcp tool: `arc_accounts_list`
- List all accounts in the active budget with balances and on/off-budget status.

```bash
arc accounts list
arc accounts list --json
```

### `arc accounts balance`

- mode: **read**
- mcp tool: `arc_accounts_balance`
- Show the current balance of a single account.

```bash
arc accounts balance --account 'HDFC Checking'
```

### `arc accounts create`

- mode: **write**
- mcp tool: `arc_accounts_create`
- Create a new account, optionally off-budget and with a starting balance.

```bash
arc accounts create --name 'Brokerage' --type investment --offbudget true
arc accounts create --name 'Cash' --balance 200
```

### `arc accounts update`

- mode: **write**
- mcp tool: `arc_accounts_update`
- Update an account's name, type, or on/off-budget flag.

```bash
arc accounts update --id 'Cash' --name 'Wallet'
```

### `arc accounts close`

- mode: **write**
- mcp tool: `arc_accounts_close`
- Close an account, optionally transferring its remaining balance to another account.

```bash
arc accounts close --id 'Old Card' --transfer-to 'New Card'
```

### `arc accounts reopen`

- mode: **write**
- mcp tool: `arc_accounts_reopen`
- Reopen a previously closed account.

```bash
arc accounts reopen --id 'Old Card'
```

### `arc accounts delete`

- mode: **write** (advanced)
- mcp tool: `arc_accounts_delete`
- Permanently delete an account. Destructive — prefer close in most cases.

```bash
arc accounts delete --id 'Test Account'
```

## Transactions

Create, update, split, transfer, and batch-process transactions.

### `arc transactions list`

- mode: **read**
- mcp tool: `arc_transactions_list`
- List transactions for an account, optionally filtered by date range.

```bash
arc transactions list --account 'HDFC Checking'
arc transactions list --account 'Card' --start 2026-01-01 --end 2026-03-31
```

### `arc transactions add`

- mode: **write**
- mcp tool: `arc_transactions_add`
- Add a single transaction to an account. Generates a deterministic imported_id when omitted.

```bash
arc transactions add --account 'Card' --date 2026-04-10 --amount -25.50 --payee 'Coffee Shop' --category 'Dining'
```

### `arc transactions import`

- mode: **write**
- mcp tool: `arc_transactions_import`
- Bulk-import transactions into an account from a JSON array, with automatic de-duplication.

```bash
arc transactions import --account 'Card' '[{"date":"2026-04-01","amount":-1234,"payee_name":"Amazon"}]'
```

### `arc transactions update`

- mode: **write**
- mcp tool: `arc_transactions_update`
- Update fields on an existing transaction by id.

```bash
arc transactions update --id <txn-id> --category 'Groceries' --notes 'Weekly run'
```

### `arc transactions delete`

- mode: **write**
- mcp tool: `arc_transactions_delete`
- Delete a transaction by id.

```bash
arc transactions delete --id <txn-id>
```

### `arc transactions split`

- mode: **write**
- mcp tool: `arc_transactions_split`
- Create a split transaction with one or more child sub-transactions.

```bash
arc transactions split --account 'Card' --date 2026-04-01 --payee 'Costco' --subs '[{"amount":-50,"category":"Groceries"},{"amount":-20,"category":"Household"}]'
```

### `arc transactions transfer`

- mode: **write**
- mcp tool: `arc_transactions_transfer`
- Create a linked transfer between two accounts.

```bash
arc transactions transfer --from 'Checking' --to 'Savings' --amount 500 --date 2026-04-10
```

### `arc transactions batch-update`

- mode: **write** (advanced)
- mcp tool: `arc_transactions_batch_update`
- Apply field updates to many transactions in one call. Accepts a JSON array of {id, ...fields}.

```bash
arc transactions batch-update '[{"id":"...","category":"Dining"},{"id":"...","notes":"vacation"}]'
```

### `arc transactions batch-add`

- mode: **write** (advanced)
- mcp tool: `arc_transactions_batch_add`
- Bulk-add transactions to an account, resolving category names and generating imported_ids.

```bash
arc transactions batch-add --account 'Card' '[{"date":"2026-04-01","amount":-12.5,"payee_name":"Bakery"}]'
```

### `arc transactions batch-categorize`

- mode: **write** (advanced)
- mcp tool: `arc_transactions_batch_categorize`
- Categorize all uncategorized transactions in an account whose payee matches a substring pattern.

```bash
arc transactions batch-categorize --account 'Card' --payee 'starbucks' --category 'Dining'
```

## Categories

Manage category groups and individual categories.

### `arc categories list`

- mode: **read**
- mcp tool: `arc_categories_list`
- List all category groups and their categories.

```bash
arc categories list
arc categories list --json
```

### `arc categories create`

- mode: **write**
- mcp tool: `arc_categories_create`
- Create a new category inside an existing category group.

```bash
arc categories create --name 'Coffee' --group 'Food'
```

### `arc categories update`

- mode: **write**
- mcp tool: `arc_categories_update`
- Rename a category, move it to a different group, or toggle hidden.

```bash
arc categories update --id 'Coffee' --group 'Dining'
```

### `arc categories delete`

- mode: **write** (advanced)
- mcp tool: `arc_categories_delete`
- Delete a category, optionally transferring its transactions and budget to another category.

```bash
arc categories delete --id 'Old' --transfer-to 'New'
```

## Payees

Manage payees, merge duplicates, and look up usage.

### `arc payees list`

- mode: **read**
- mcp tool: `arc_payees_list`
- List all payees. Pass --all to include hidden / system payees.

```bash
arc payees list
arc payees list --all
```

### `arc payees create`

- mode: **write**
- mcp tool: `arc_payees_create`
- Create a new payee by name.

```bash
arc payees create --name 'Local Bakery'
```

### `arc payees update`

- mode: **write**
- mcp tool: `arc_payees_update`
- Rename an existing payee.

```bash
arc payees update --id 'Bakery' --name 'Local Bakery'
```

### `arc payees find-or-create`

- mode: **write**
- mcp tool: `arc_payees_find_or_create`
- Look up a payee by name and create it if missing. Returns the payee id.

```bash
arc payees find-or-create --name 'Local Bakery'
```

### `arc payees common`

- mode: **read**
- mcp tool: `arc_payees_common`
- List the most frequently used payees, ordered by transaction count.

```bash
arc payees common --limit 10
```

### `arc payees delete`

- mode: **write** (advanced)
- mcp tool: `arc_payees_delete`
- Delete a payee. Linked transactions become payee-less.

```bash
arc payees delete --id 'Old Vendor'
```

### `arc payees merge`

- mode: **write** (advanced)
- mcp tool: `arc_payees_merge`
- Merge one or more payees into a target payee. Comma-separated source list.

```bash
arc payees merge --target 'Amazon' --merge 'AMZN,Amazon.com,Amzn Mktp'
```

## Rules

Define and maintain auto-categorization and payee-cleanup rules.

### `arc rules list`

- mode: **read**
- mcp tool: `arc_rules_list`
- List all transaction rules in the active budget.

```bash
arc rules list
arc rules list --json
```

### `arc rules create`

- mode: **write**
- mcp tool: `arc_rules_create`
- Create a rule from a JSON payload. Account/category/payee names in conditions and actions are auto-resolved to ids.

```bash
arc rules create '{"stage":"pre","conditionsOp":"and","conditions":[{"field":"payee","op":"is","value":"Starbucks"}],"actions":[{"field":"category","op":"set","value":"Dining"}]}'
```

### `arc rules update`

- mode: **write**
- mcp tool: `arc_rules_update`
- Update an existing rule. The JSON payload must include the rule id.

```bash
arc rules update '{"id":"...","actions":[...]}'
```

### `arc rules delete`

- mode: **write**
- mcp tool: `arc_rules_delete`
- Delete a rule by id.

```bash
arc rules delete --id <rule-id>
```

## Schedules

Manage recurring schedules and post them as transactions.

### `arc schedules list`

- mode: **read**
- mcp tool: `arc_schedules_list`
- List all recurring schedules.

```bash
arc schedules list
```

### `arc schedules create`

- mode: **write**
- mcp tool: `arc_schedules_create`
- Create a recurring schedule from a JSON payload. Account/category/payee names are auto-resolved.

```bash
arc schedules create '{"name":"Rent","account":"Checking","payee":"Landlord","amount":-150000,"date":{"start":"2026-05-01","frequency":"monthly"}}'
```

### `arc schedules update`

- mode: **write**
- mcp tool: `arc_schedules_update`
- Update an existing schedule by id with a JSON payload of fields to change.

```bash
arc schedules update --id <sched-id> '{"amount":-160000}'
```

### `arc schedules delete`

- mode: **write**
- mcp tool: `arc_schedules_delete`
- Delete a schedule by id.

```bash
arc schedules delete --id <sched-id>
```

### `arc schedules post`

- mode: **write**
- mcp tool: `arc_schedules_post`
- Materialize a schedule as a real transaction on the given date (defaults to next due date).

```bash
arc schedules post --id <sched-id>
arc schedules post --id <sched-id> --date 2026-05-01
```

### `arc schedules upcoming`

- mode: **read**
- mcp tool: `arc_schedules_upcoming`
- List schedules sorted by next due date.

```bash
arc schedules upcoming
```

### `arc schedules complete`

- mode: **write**
- mcp tool: `arc_schedules_complete`
- Mark a schedule as completed so it stops generating new occurrences.

```bash
arc schedules complete --id <sched-id>
```

## Budgets

Inspect budget months, set budgeted amounts, and switch between budgets.

### `arc budgets list`

- mode: **read**
- mcp tool: `arc_budgets_list`
- List budget files available on the configured Actual server.

```bash
arc budgets list
arc budgets list --json
```

### `arc budgets months`

- mode: **read**
- mcp tool: `arc_budgets_months`
- List the budget months Actual has data for.

```bash
arc budgets months
```

### `arc budgets month` (alias: `show`)

- mode: **read**
- mcp tool: `arc_budgets_month`
- Show the full budget for a single month (categories, budgeted, spent, balance).

```bash
arc budgets month --month 2026-04
arc budgets show --month 2026-04
```

### `arc budgets set-amount`

- mode: **write**
- mcp tool: `arc_budgets_set_amount`
- Set the budgeted amount for a category in a given month.

```bash
arc budgets set-amount --month 2026-04 --category 'Groceries' --amount 600
```

### `arc budgets set-carryover`

- mode: **write**
- mcp tool: `arc_budgets_set_carryover`
- Enable or disable budget carryover (rollover) for a category in a given month.

```bash
arc budgets set-carryover --month 2026-04 --category 'Travel' --enabled true
```

### `arc budgets transfer`

- mode: **write**
- mcp tool: `arc_budgets_transfer`
- Move budgeted money between two categories within the same month.

```bash
arc budgets transfer --month 2026-04 --from 'Dining' --to 'Groceries' --amount 50
```

### `arc budgets income`

- mode: **read**
- mcp tool: `arc_budgets_income`
- Show income categories with budgeted vs received totals for a month.

```bash
arc budgets income --month 2026-04
```

### `arc budgets summary` (alias: `totals`)

- mode: **read**
- mcp tool: `arc_budgets_summary`
- Top-line totals for a month: total budgeted, spent, balance, and to-budget.

```bash
arc budgets summary --month 2026-04
arc budgets totals --month 2026-04
```

### `arc budgets switch`

- mode: **write** (advanced)
- mcp tool: `arc_budgets_switch`
- Switch the active budget file for subsequent commands. Persists the selection in the credential store.

```bash
arc budgets switch --budget 'Family Budget'
```

## Query

Read-only reports and ad-hoc Actual queries.

### `arc query spending`

- mode: **read**
- mcp tool: `arc_query_spending`
- Spending summary for a month broken down by category.

```bash
arc query spending --month 2026-04
```

### `arc query accounts` (alias: `summary`)

- mode: **read**
- mcp tool: `arc_query_accounts`
- Account summary report with balances and on/off-budget grouping.

```bash
arc query accounts
arc query summary
```

### `arc query uncategorized`

- mode: **read**
- mcp tool: `arc_query_uncategorized`
- List uncategorized transactions, optionally scoped to one account.

```bash
arc query uncategorized
arc query uncategorized --account 'Card'
```

### `arc query payee`

- mode: **read**
- mcp tool: `arc_query_payee`
- Recent transactions for a single payee across all accounts.

```bash
arc query payee --name 'Amazon' --limit 50
```

### `arc query category`

- mode: **read**
- mcp tool: `arc_query_category`
- Transactions in a single category, optionally filtered by date range.

```bash
arc query category --name 'Groceries' --start 2026-01-01 --end 2026-03-31
```

### `arc query trends`

- mode: **read**
- mcp tool: `arc_query_trends`
- Per-category spending trend over the last N months.

```bash
arc query trends --months 6
```

### `arc query top` (alias: `top-categories`)

- mode: **read**
- mcp tool: `arc_query_top`
- Top spending categories for a month, ranked by amount spent.

```bash
arc query top --month 2026-04 --limit 10
```

### `arc query monthly` (alias: `monthly-totals`)

- mode: **read**
- mcp tool: `arc_query_monthly`
- Income, expenses, and net totals per month for the last N months.

```bash
arc query monthly --months 12
arc query monthly-totals --months 6
```

### `arc query balance-history`

- mode: **read**
- mcp tool: `arc_query_balance_history`
- Daily running balance for an account over the last N months.

```bash
arc query balance-history --account 'Checking' --months 6
```

### `arc query monthly-balances`

- mode: **read**
- mcp tool: `arc_query_monthly_balances`
- End-of-month balance series for an account over the last N months.

```bash
arc query monthly-balances --account 'Checking' --months 12
```

### `arc query custom`

- mode: **read** (advanced)
- mcp tool: `arc_query_custom`
- Run a raw Actual query (ActualQL JSON). Advanced — for power users only.

```bash
arc query custom --q '{"table":"transactions","select":["id","amount"]}'
```

## MCP Parity

Running `arc mcp` starts a stdio MCP server that registers one tool per entry above. Tool names follow `arc_<group>_<subcommand>` (hyphens become underscores). The same argument names, defaults, and validation rules apply on both surfaces.

<!-- END:ARC_OPERATIONS_SKILL -->
