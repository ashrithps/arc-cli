# arc cli

<!--
⚠️  GENERATED FILE — do not edit directly.

This README is produced by scripts/publish-public.sh in arc-cli-source.
Any hand edits here will be overwritten on the next publish.

Hand content lives in the heredoc template inside publish-public.sh.
The operation catalog between BEGIN:ARC_OPERATIONS_README and
END:ARC_OPERATIONS_README markers is generated from the registry at
src/public-surface/operation-registry.ts.
-->

arc cli connects to your budget hosted on [arc](https://arc.moi). Once signed in, open **Settings → Apps** to find the one-command CLI installer that is pre-baked with your instance URL and credentials.

arc is the installed CLI, TUI, and MCP surface for [Actual Budget](https://actualbudget.org). One install gives you:

- an `arc` command-line interface covering accounts, transactions, categories, payees, rules, schedules, budget months, and reports
- a terminal UI via `arc ui`
- a stdio MCP server via `arc mcp` that exposes every data operation as a structured tool for agents

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ashrithps/arc-cli/main/install.sh | bash
```

If you copied a payload-backed command from the **Apps** section of your [arc](https://arc.moi) settings, run that exact command instead. It bootstraps arc directly into your current budget without any manual config.

### One-Command Payload Bootstrap

The payload command is:

```bash
curl -fsSL https://raw.githubusercontent.com/ashrithps/arc-cli/main/install.sh | bash -s -- --payload '<json-payload>'
```

The payload contains your API URL, API key, sync id, and (optionally) an encryption password. Treat it like a secret and run it only on a trusted machine — it gives arc full access to the budget it was generated for.

### Agent Install Matrix

The installer detects which agent tools you have on the machine and drops the arc skill into each one's conventional location, plus a fallback under `~/.config/arc/SKILL.md`. Expected targets include Claude Code, Codex, Cursor, Windsurf / Codeium, Cline / Roo, Amp, Gemini CLI / Antigravity, GitHub Copilot, Goose, OpenCode, Trae, Kilo, Augment, Aider, and VS Code's skills folder. Agents you don't use stay untouched.

### MCP Behavior

arc also registers an `arc` entry in Claude Desktop's `claude_desktop_config.json` that runs `arc mcp`. The MCP server exposes one tool per operation in the catalog below, with the same argument names and validation as the CLI. Existing MCP servers in the config file are preserved — the installer only adds / updates the `arc` entry.

### Remote MCP for Claude.ai web / mobile

`arc mcp --http` runs the same 70 tools as a Streamable HTTP MCP server instead of stdio. Combined with a tunnel (cloudflare tunnel, tailscale funnel, ngrok, etc.) it lets the Claude.ai web app, Claude mobile app, and Cursor's remote-MCP feature talk to your local arc.

```bash
# Loopback only, generates a random bearer token and prints it
arc mcp --http

# Custom port + token, ready to expose via tunnel
arc mcp --http --port 8765 --token $(openssl rand -hex 32)

# Tunnel it (example with cloudflare quick tunnel — no account needed)
cloudflared tunnel --url http://127.0.0.1:8765
# → https://random-words.trycloudflare.com
```

Then in Claude.ai → **Settings → Connectors → Add custom connector**:
- **URL**: `https://random-words.trycloudflare.com/mcp`
- **Authorization header**: `Bearer <token>`

The remote server keeps the same `withRealClient` cache + 90s idle timeout, so a chat conversation pays the connect cost once and subsequent tool calls are instant.

Security:
- Bearer token is required for any non-loopback bind. Constant-time compared to defeat timing probes.
- Default bind is `127.0.0.1` — pass `--host 0.0.0.0` only when intentionally exposing.
- The token is printed on stderr at startup; redirect or capture it.
- Anyone with the URL + token gets full read **and write** access to the budget. Treat the token like the Actual API key.

## Runtime

- Installed app snapshot: `~/.arc-cli/app`
- Installed config: `~/.arc-cli/config.json`
- Launcher: `~/.local/bin/arc`
- Switch budgets later with `arc budgets switch --budget <id>`
- `arc ui` launches the TUI
- `arc mcp` starts the stdio MCP server

## Security Notes

- macOS-first installer (Linux works for the CLI; the Claude Desktop merge step is a no-op elsewhere).
- Payload-backed install commands embed credentials. Only run them on trusted machines.
- Per-budget encryption passwords are stored in the credential store after the first successful unlock.

## Commands

<!-- BEGIN:ARC_OPERATIONS_README -->
<!-- Generated from src/public-surface/operation-registry.ts. Do not edit by hand. -->

Arc exposes the commands below both as CLI subcommands and as MCP tools (`arc mcp`). Every entry is generated from the single operation registry, so the CLI, MCP, and docs always match.

## Accounts

Manage on- and off-budget accounts and balances.

- **`arc accounts list`** — List all accounts in the active budget with balances and on/off-budget status.

  ```bash
  arc accounts list
  ```

- **`arc accounts balance`** — Show the current balance of a single account.

  ```bash
  arc accounts balance --account 'HDFC Checking'
  ```

- **`arc accounts create`** — Create a new account, optionally off-budget and with a starting balance.

  ```bash
  arc accounts create --name 'Brokerage' --type investment --offbudget true
  ```

- **`arc accounts update`** — Update an account's name, type, or on/off-budget flag.

  ```bash
  arc accounts update --id 'Cash' --name 'Wallet'
  ```

- **`arc accounts close`** — Close an account, optionally transferring its remaining balance to another account.

  ```bash
  arc accounts close --id 'Old Card' --transfer-to 'New Card'
  ```

- **`arc accounts reopen`** — Reopen a previously closed account.

  ```bash
  arc accounts reopen --id 'Old Card'
  ```

- **`arc accounts delete`** — Permanently delete an account. Destructive — prefer close in most cases. _(advanced)_

  ```bash
  arc accounts delete --id 'Test Account'
  ```

## Transactions

Create, update, split, transfer, and batch-process transactions.

- **`arc transactions list`** — List transactions for an account, optionally filtered by date range. Pass `--tag` to search across ALL accounts by tag (`--account` becomes optional and narrows results when set).

  ```bash
  arc transactions list --account 'HDFC Checking'
  ```

- **`arc transactions add`** — Add a single transaction to an account. Generates a deterministic imported_id when omitted.

  ```bash
  arc transactions add --account 'Card' --date 2026-04-10 --amount -25.50 --payee 'Coffee Shop' --category 'Dining'
  ```

- **`arc transactions import`** — Bulk-import transactions into an account from a JSON array, with automatic de-duplication.

  ```bash
  arc transactions import --account 'Card' '[{"date":"2026-04-01","amount":-1234,"payee_name":"Amazon"}]'
  ```

- **`arc transactions update`** — Update fields on an existing transaction by id. Use `--add-tag` / `--remove-tag` to mutate `#tag` tokens in notes without rewriting the prose.

  ```bash
  arc transactions update --id <txn-id> --category 'Groceries' --notes 'Weekly run'
  ```

- **`arc transactions delete`** — Delete a transaction by id.

  ```bash
  arc transactions delete --id <txn-id>
  ```

- **`arc transactions split`** — Create a split transaction with one or more child sub-transactions.

  ```bash
  arc transactions split --account 'Card' --date 2026-04-01 --payee 'Costco' --subs '[{"amount":-50,"category":"Groceries"},{"amount":-20,"category":"Household"}]'
  ```

- **`arc transactions transfer`** — Create a linked transfer between two accounts.

  ```bash
  arc transactions transfer --from 'Checking' --to 'Savings' --amount 500 --date 2026-04-10
  ```

- **`arc transactions batch-update`** — Apply field updates to many transactions in one call. Accepts a JSON array of {id, ...fields}. _(advanced)_

  ```bash
  arc transactions batch-update '[{"id":"...","category":"Dining"},{"id":"...","notes":"vacation"}]'
  ```

- **`arc transactions batch-add`** — Bulk-add transactions to an account, resolving category names and generating imported_ids. _(advanced)_

  ```bash
  arc transactions batch-add --account 'Card' '[{"date":"2026-04-01","amount":-12.5,"payee_name":"Bakery"}]'
  ```

- **`arc transactions batch-categorize`** — Categorize all uncategorized transactions in an account whose payee matches a substring pattern. _(advanced)_

  ```bash
  arc transactions batch-categorize --account 'Card' --payee 'starbucks' --category 'Dining'
  ```

## Categories

Manage category groups and individual categories.

- **`arc categories list`** — List all category groups and their categories.

  ```bash
  arc categories list
  ```

- **`arc categories create`** — Create a new category inside an existing category group.

  ```bash
  arc categories create --name 'Coffee' --group 'Food'
  ```

- **`arc categories update`** — Rename a category, move it to a different group, or toggle hidden.

  ```bash
  arc categories update --id 'Coffee' --group 'Dining'
  ```

- **`arc categories delete`** — Delete a category, optionally transferring its transactions and budget to another category. _(advanced)_

  ```bash
  arc categories delete --id 'Old' --transfer-to 'New'
  ```

## Payees

Manage payees, merge duplicates, and look up usage.

- **`arc payees list`** — List all payees. Pass --all to include hidden / system payees.

  ```bash
  arc payees list
  ```

- **`arc payees create`** — Create a new payee by name.

  ```bash
  arc payees create --name 'Local Bakery'
  ```

- **`arc payees update`** — Rename an existing payee.

  ```bash
  arc payees update --id 'Bakery' --name 'Local Bakery'
  ```

- **`arc payees find-or-create`** — Look up a payee by name and create it if missing. Returns the payee id.

  ```bash
  arc payees find-or-create --name 'Local Bakery'
  ```

- **`arc payees common`** — List the most frequently used payees, ordered by transaction count.

  ```bash
  arc payees common --limit 10
  ```

- **`arc payees delete`** — Delete a payee. Linked transactions become payee-less. _(advanced)_

  ```bash
  arc payees delete --id 'Old Vendor'
  ```

- **`arc payees merge`** — Merge one or more payees into a target payee. Comma-separated source list. _(advanced)_

  ```bash
  arc payees merge --target 'Amazon' --merge 'AMZN,Amazon.com,Amzn Mktp'
  ```

## Tags

Manage Actual Budget tags (color, description) and apply / unapply them on transactions. Tag membership lives in transaction notes as `#tag`.

- **`arc tags list`** — List all tags with their colors and optional descriptions.

  ```bash
  arc tags list
  ```

- **`arc tags add`** — Create a new tag. The leading `#` is optional and stripped if present.

  ```bash
  arc tags add --name Quantini
  ```

- **`arc tags update`** — Rename a tag, change its color, or update its description. `--id` accepts the tag name or its UUID.

  ```bash
  arc tags update --id Quantini --color '#FF6B6B'
  ```

- **`arc tags apply`** — Append one or more tags to a transaction's notes. Comma-separated for multi-tag. Idempotent.

  ```bash
  arc tags apply --transaction <tx-id> --tag Quantini
  ```

- **`arc tags unapply`** — Remove one or more `#tag` tokens from a transaction's notes.

  ```bash
  arc tags unapply --transaction <tx-id> --tag Quantini
  ```

- **`arc tags delete`** — Soft-delete a tag from the tag library. Existing transactions retain the `#tag` text in their notes — you must remove those separately. _(advanced)_

  ```bash
  arc tags delete --id Quantini
  ```

## Rules

Define and maintain auto-categorization and payee-cleanup rules.

- **`arc rules list`** — List all transaction rules in the active budget.

  ```bash
  arc rules list
  ```

- **`arc rules create`** — Create a rule from a JSON payload. Account/category/payee names in conditions and actions are auto-resolved to ids.

  ```bash
  arc rules create '{"stage":"pre","conditionsOp":"and","conditions":[{"field":"payee","op":"is","value":"Starbucks"}],"actions":[{"field":"category","op":"set","value":"Dining"}]}'
  ```

- **`arc rules update`** — Update an existing rule. The JSON payload must include the rule id.

  ```bash
  arc rules update '{"id":"...","actions":[...]}'
  ```

- **`arc rules delete`** — Delete a rule by id.

  ```bash
  arc rules delete --id <rule-id>
  ```

## Schedules

Manage recurring schedules and post them as transactions.

- **`arc schedules list`** — List all recurring schedules.

  ```bash
  arc schedules list
  ```

- **`arc schedules create`** — Create a recurring schedule from a JSON payload. Account/category/payee names are auto-resolved.

  ```bash
  arc schedules create '{"name":"Rent","account":"Checking","payee":"Landlord","amount":-150000,"date":{"start":"2026-05-01","frequency":"monthly"}}'
  ```

- **`arc schedules update`** — Update an existing schedule by id with a JSON payload of fields to change.

  ```bash
  arc schedules update --id <sched-id> '{"amount":-160000}'
  ```

- **`arc schedules delete`** — Delete a schedule by id.

  ```bash
  arc schedules delete --id <sched-id>
  ```

- **`arc schedules post`** — Materialize a schedule as a real transaction on the given date (defaults to next due date).

  ```bash
  arc schedules post --id <sched-id>
  ```

- **`arc schedules upcoming`** — List schedules sorted by next due date.

  ```bash
  arc schedules upcoming
  ```

- **`arc schedules complete`** — Mark a schedule as completed so it stops generating new occurrences.

  ```bash
  arc schedules complete --id <sched-id>
  ```

## Budgets

Inspect budget months, set budgeted amounts, and switch between budgets.

- **`arc budgets list`** — List budget files available on the configured Actual server.

  ```bash
  arc budgets list
  ```

- **`arc budgets months`** — List the budget months Actual has data for.

  ```bash
  arc budgets months
  ```

- **`arc budgets month`** (alias: `show`) — Show the full budget for a single month (categories, budgeted, spent, balance).

  ```bash
  arc budgets month --month 2026-04
  ```

- **`arc budgets set-amount`** — Set the budgeted amount for a category in a given month.

  ```bash
  arc budgets set-amount --month 2026-04 --category 'Groceries' --amount 600
  ```

- **`arc budgets set-carryover`** — Enable or disable budget carryover (rollover) for a category in a given month.

  ```bash
  arc budgets set-carryover --month 2026-04 --category 'Travel' --enabled true
  ```

- **`arc budgets transfer`** — Move budgeted money between two categories within the same month.

  ```bash
  arc budgets transfer --month 2026-04 --from 'Dining' --to 'Groceries' --amount 50
  ```

- **`arc budgets income`** — Show income categories with budgeted vs received totals for a month.

  ```bash
  arc budgets income --month 2026-04
  ```

- **`arc budgets summary`** (alias: `totals`) — Top-line totals for a month: total budgeted, spent, balance, and to-budget.

  ```bash
  arc budgets summary --month 2026-04
  ```

- **`arc budgets switch`** — Switch the active budget file for subsequent commands. Persists the selection in the credential store. _(advanced)_

  ```bash
  arc budgets switch --budget 'Family Budget'
  ```

## Query

Read-only reports and ad-hoc Actual queries.

- **`arc query spending`** — Spending summary for a month broken down by category.

  ```bash
  arc query spending --month 2026-04
  ```

- **`arc query accounts`** (alias: `summary`) — Account summary report with balances and on/off-budget grouping.

  ```bash
  arc query accounts
  ```

- **`arc query uncategorized`** — List uncategorized transactions, optionally scoped to one account.

  ```bash
  arc query uncategorized
  ```

- **`arc query payee`** — Recent transactions for a single payee across all accounts.

  ```bash
  arc query payee --name 'Amazon' --limit 50
  ```

- **`arc query category`** — Transactions in a single category, optionally filtered by date range.

  ```bash
  arc query category --name 'Groceries' --start 2026-01-01 --end 2026-03-31
  ```

- **`arc query trends`** — Per-category spending trend over the last N months.

  ```bash
  arc query trends --months 6
  ```

- **`arc query top`** (alias: `top-categories`) — Top spending categories for a month, ranked by amount spent.

  ```bash
  arc query top --month 2026-04 --limit 10
  ```

- **`arc query monthly`** (alias: `monthly-totals`) — Income, expenses, and net totals per month for the last N months.

  ```bash
  arc query monthly --months 12
  ```

- **`arc query balance-history`** — Daily running balance for an account over the last N months.

  ```bash
  arc query balance-history --account 'Checking' --months 6
  ```

- **`arc query monthly-balances`** — End-of-month balance series for an account over the last N months.

  ```bash
  arc query monthly-balances --account 'Checking' --months 12
  ```

- **`arc query custom`** — Run a raw Actual query (ActualQL JSON). Advanced — for power users only. _(advanced)_

  ```bash
  arc query custom --q '{"table":"transactions","select":["id","amount"]}'
  ```

## Portfolio

Track investment holdings and trade activity (read-only). Investment data lives in account notes (`#investment:` / `#hold:v1:`) and `#act:`-tagged transactions.

- **`arc portfolio list`** — List holdings across all detailed investment accounts (symbol, asset class, quantity, price, value, unrealized P/L %).

  ```bash
  arc portfolio list
  ```

- **`arc portfolio holding`** — Detail for one holding — quantity, price, average cost, market value, unrealized P/L, allocation %, plus its trade ledger.

  ```bash
  arc portfolio holding --symbol AAPL
  ```

- **`arc portfolio trades`** — Trade / activity ledger (buys, sells, fees, dividends, …) across investment accounts and their paired cash accounts.

  ```bash
  arc portfolio trades --symbol AAPL
  ```

- **`arc portfolio summary`** — Portfolio totals — total market value, total unrealized P/L, and allocation by account and by asset class.

  ```bash
  arc portfolio summary
  ```

- **`arc portfolio accounts`** — List investment accounts with their kind (stock/crypto), tracking mode (simple/detailed), data source, and value.

  ```bash
  arc portfolio accounts
  ```

<!-- END:ARC_OPERATIONS_README -->

## Dashboard Recipes

arc ships with 13 pre-built dashboard recipes that any AI agent can use to generate beautiful, self-contained HTML financial dashboards from your budget data. Recipes live in [`skill/recipes/`](skill/recipes/).

| Recipe | Description |
|---|---|
| [recipe-spending](skill/recipes/recipe-spending.md) | Monthly spending breakdown with donut chart and category cards |
| [recipe-trends](skill/recipes/recipe-trends.md) | Month-on-month income vs expense trends with heatmap |
| [recipe-budget](skill/recipes/recipe-budget.md) | Budget vs actual with adherence indicators |
| [recipe-accounts](skill/recipes/recipe-accounts.md) | Account overview and net worth |
| [recipe-recurring](skill/recipes/recipe-recurring.md) | Recurring payments / subscription tracker |
| [recipe-payees](skill/recipes/recipe-payees.md) | Payee / merchant spending analysis |
| [recipe-income](skill/recipes/recipe-income.md) | Income report with sources and trends |
| [recipe-category](skill/recipes/recipe-category.md) | Single-category deep dive over time |
| [recipe-balance](skill/recipes/recipe-balance.md) | Account balance history with daily chart |
| [recipe-health](skill/recipes/recipe-health.md) | Financial health scorecard (0-100 score) |
| [recipe-annual](skill/recipes/recipe-annual.md) | Full-year summary with quarterly breakdown |
| [recipe-uncategorized](skill/recipes/recipe-uncategorized.md) | Data quality / uncategorized transactions |
| [recipe-upcoming](skill/recipes/recipe-upcoming.md) | Upcoming payment calendar with coverage |

### Creating Your Own Recipes

Recipes are plain Markdown files that tell AI agents how to generate a dashboard. Anyone can create and share recipes — no code required.

Every recipe file follows this structure:

    ---
    name: recipe-my-custom
    description: One-line description of what this dashboard shows
    ---

    # Dashboard Title

    ## Trigger
    Phrases that should activate this recipe

    ## Data Commands
    Exact arc CLI commands to run with --json flag

    ## Layout
    Component-by-component description, top to bottom

    ## Design
    Color choices, accent colors, special formatting rules

    ## Empty State
    What to show when no data is available

All recipes must use the arc dark editorial theme (near-black background, DM Serif Display + Outfit + JetBrains Mono fonts, arc nav bar with logo). See [recipe-spending.md](skill/recipes/recipe-spending.md) for a complete example.

**To contribute a recipe:**

1. Fork this repo
2. Add your recipe-*.md file to skill/recipes/
3. Open a PR with a description of the dashboard and a screenshot

**To use a custom recipe locally**, drop your recipe-*.md file into the arc-dashboard-design skill directory:

- Claude Code: ~/.claude/skills/arc-dashboard-design/
- Cursor: ~/.cursor/skills/arc-dashboard-design/
- Generic: ~/.config/arc/recipes/
