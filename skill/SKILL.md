---
name: arc
description: "Use Arc to work with Actual budgets, including multi-budget switching, the TUI, and MCP tooling."
---

# Arc CLI

Use `arc` for Actual Budget work. The installed command is `arc`, not `arctual`.

## Core Commands

```bash
arc budgets list --json
arc budgets switch --budget <sync-id>
arc accounts list --json
arc transactions list --account <account-id> --start 2026-04-01 --end 2026-04-30 --json
arc ui
arc mcp
```

## Multi-Budget Rules

- Use `arc budgets list` to discover available budgets.
- Use `arc budgets switch --budget <id>` to change the default installed budget.
- Encrypted secondary budgets can be switched with `--password '<pw>'` once, after which Arc saves the password per budget.
- Regular commands can also target another budget with `--budget <id>`.

## Installed Runtime

- Installed config lives under `~/.arc-cli/config.json`.
- The launcher lives at `~/.local/bin/arc`.
- `arc config show --json` shows the installed config summary with secrets redacted.

## Agents

- Use `arc mcp` as the MCP server command for Claude Desktop or other MCP clients.
- The MCP server exposes budget listing, budget switching, account listing, and transaction listing tools.
