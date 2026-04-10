# Arc CLI

Arc is the installed CLI, TUI, and MCP surface for Actual Budget.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ashrithgovind/arc-cli/main/install.sh | bash
```

If you copied a payload-backed command from `budgetarc`, use that exact command instead so Arc boots into your current budget automatically.

The copied command installs:

- the `arc` CLI
- the current TUI via `arc ui`
- the Arc skill for Codex
- a Claude Desktop MCP entry that runs `arc mcp`

## Commands

```bash
arc budgets list --json
arc budgets switch --budget <sync-id>
arc accounts list --json
arc transactions list --account <account-id> --start 2026-04-01 --end 2026-04-30 --json
arc ui
arc mcp
```

## Runtime

- Installed app directory: `~/.arc-cli/app`
- Installed config: `~/.arc-cli/config.json`
- Launcher: `~/.local/bin/arc`
- Current budget can be changed later with `arc budgets switch --budget <id>`

## Agents

- Codex skill: `~/.codex/skills/arc/SKILL.md`
- Claude Desktop MCP command: `arc mcp`

## Notes

- macOS-first installer
- payload-backed commands should be used only on a trusted machine because they include budget credentials
