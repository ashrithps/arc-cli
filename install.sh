#!/usr/bin/env bash
# Arc CLI installer — one-line install for macOS (Linux works for CLI).
#
# Basic:
#   curl -fsSL https://raw.githubusercontent.com/ashrithps/arc-cli/main/install.sh | bash
#
# One-command payload bootstrap:
#   curl -fsSL https://raw.githubusercontent.com/ashrithps/arc-cli/main/install.sh | bash -s -- \
#     --payload '<json-payload>'
#
# Source of truth: arc-cli-source/public/install.sh
# scripts/publish-public.sh copies this file verbatim into arc-cli/install.sh.
#
# Agent skill target matrix is ported from moivault/install.sh with `moivault`
# replaced by `arc`. Agents you don't use stay untouched.
set -euo pipefail

ARC_HOME="${HOME}/.arc-cli"
APP_DIR="${ARC_HOME}/app"
BIN_DIR="${HOME}/.local/bin"
CLAUDE_CONFIG_DIR="${HOME}/Library/Application Support/Claude"
CLAUDE_CONFIG_PATH="${CLAUDE_CONFIG_DIR}/claude_desktop_config.json"
REPO_TARBALL_URL="${ARC_CLI_TARBALL_URL:-https://codeload.github.com/ashrithps/arc-cli/tar.gz/refs/heads/main}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

PAYLOAD=""
SKILLS_ONLY=0
SKILL_FILE_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --payload)
      PAYLOAD="${2:-}"
      shift 2
      ;;
    --skills-only)
      SKILLS_ONLY=1
      shift
      ;;
    --skill-file)
      SKILL_FILE_OVERRIDE="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# ─── Helpers ────────────────────────────────────────────────────────────────

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

SKILL_INSTALLED=""

# install_skill DEST_DIR LABEL
#   Copies the resolved SKILL_FILE into $DEST_DIR/SKILL.md (creating parents).
install_skill() {
  local dir="$1" name="$2"
  mkdir -p "$dir"
  cp "$SKILL_FILE" "$dir/SKILL.md"
  SKILL_INSTALLED="$SKILL_INSTALLED $name"
}

# install_agent_skills
#   Drops the Arc skill into every detected agent's conventional location,
#   plus the generic fallback at ~/.config/arc/SKILL.md. Mirrors the moivault
#   target matrix so the two installers stay in lockstep.
install_agent_skills() {
  # Claude Code / Claude Desktop
  [ -d "$HOME/.claude" ] && install_skill "$HOME/.claude/skills/arc" "claude-code"

  # Codex (OpenAI) — plus AGENTS.md note
  if [ -d "$HOME/.codex" ] || command -v codex >/dev/null 2>&1; then
    install_skill "$HOME/.codex/skills/arc" "codex"
    local codex_agents="$HOME/.codex/AGENTS.md"
    if ! grep -q "arc" "$codex_agents" 2>/dev/null; then
      cat >> "$codex_agents" <<'EOF'

## arc
Arc CLI, TUI, and MCP surface for Actual Budget. See `~/.codex/skills/arc/SKILL.md` for the full reference.
EOF
    fi
  fi

  # Cursor
  [ -d "$HOME/.cursor" ] && install_skill "$HOME/.cursor/skills/arc" "cursor"

  # Windsurf / Codeium
  if [ -d "$HOME/.windsurf" ] || [ -d "$HOME/.codeium" ]; then
    install_skill "$HOME/.windsurf/skills/arc" "windsurf"
  fi

  # Cline / Roo Code (shared .agents/skills)
  if [ -d "$HOME/.cline" ] || [ -d "$HOME/.roo" ]; then
    install_skill "$HOME/.agents/skills/arc" "cline"
  fi

  # Amp
  [ -d "$CONFIG_HOME/amp" ] && install_skill "$CONFIG_HOME/amp/agents/skills/arc" "amp"

  # Gemini CLI / Antigravity
  [ -d "$HOME/.gemini" ] && install_skill "$HOME/.gemini/antigravity/skills/arc" "gemini"

  # GitHub Copilot
  [ -d "$HOME/.github-copilot" ] && install_skill "$HOME/.github-copilot/skills/arc" "copilot"

  # Goose (Block)
  [ -d "$CONFIG_HOME/goose" ] && install_skill "$CONFIG_HOME/goose/skills/arc" "goose"

  # OpenCode
  [ -d "$CONFIG_HOME/opencode" ] && install_skill "$CONFIG_HOME/opencode/skills/arc" "opencode"

  # Trae
  [ -d "$HOME/.trae" ] && install_skill "$HOME/.trae/skills/arc" "trae"

  # Kilo
  [ -d "$HOME/.kilo" ] && install_skill "$HOME/.kilo/skills/arc" "kilo"

  # Augment
  [ -d "$HOME/.augment" ] && install_skill "$HOME/.augment/skills/arc" "augment"

  # Aider
  [ -d "$HOME/.aider" ] && install_skill "$HOME/.aider/skills/arc" "aider"

  # VSCode (GitHub Copilot Chat instructions)
  local vscode_dir="$HOME/.vscode"
  if [ -d "$HOME/Library/Application Support/Code" ]; then
    vscode_dir="$HOME/Library/Application Support/Code/User"
  fi
  [ -d "$vscode_dir" ] && install_skill "$vscode_dir/skills/arc" "vscode"

  # Generic fallback: any agent can discover ~/.config/arc/SKILL.md
  mkdir -p "$HOME/.config/arc"
  cp "$SKILL_FILE" "$HOME/.config/arc/SKILL.md"

  if [ -n "$SKILL_INSTALLED" ]; then
    echo "  ✓ Agent skills installed:$SKILL_INSTALLED"
  else
    echo "  ✓ Skill file at: ~/.config/arc/SKILL.md"
  fi
}

# merge_claude_desktop_mcp ARC_BIN
#   Adds an `arc` entry under mcpServers without dropping existing entries.
merge_claude_desktop_mcp() {
  local arc_bin="$1"
  [ -d "$HOME/Library/Application Support/Claude" ] || return 0
  mkdir -p "$CLAUDE_CONFIG_DIR"
  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi
  node - "$CLAUDE_CONFIG_PATH" "$arc_bin" <<'NODE'
const fs = require('fs');
const path = require('path');

const [configPath, arcPath] = process.argv.slice(2);
let config = {};
if (fs.existsSync(configPath)) {
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { config = {}; }
}
if (!config.mcpServers || typeof config.mcpServers !== 'object') {
  config.mcpServers = {};
}
config.mcpServers.arc = { command: arcPath, args: ['mcp'] };
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
NODE
}

# ─── Skills-only mode ───────────────────────────────────────────────────────
# Used by tests/installer-parity.test.ts to exercise the skill matrix against
# a temp HOME without running npm or hitting the network.

if [[ "$SKILLS_ONLY" -eq 1 ]]; then
  if [[ -z "$SKILL_FILE_OVERRIDE" ]]; then
    echo "--skills-only requires --skill-file <path>" >&2
    exit 2
  fi
  SKILL_FILE="$SKILL_FILE_OVERRIDE"
  if [[ ! -f "$SKILL_FILE" ]]; then
    echo "Skill file not found: $SKILL_FILE" >&2
    exit 2
  fi
  install_agent_skills
  merge_claude_desktop_mcp "${BIN_DIR}/arc"
  exit 0
fi

# ─── Full install ───────────────────────────────────────────────────────────

need_cmd node
need_cmd npm
need_cmd curl

# When piped via `curl | bash`, BASH_SOURCE is unset so we cannot resolve a
# script directory. In that case SCRIPT_DIR stays empty and we fall through
# to the tarball download path.
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || SCRIPT_DIR=""
fi
WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/package.json" && -f "${SCRIPT_DIR}/bin/arc.js" && -d "${SCRIPT_DIR}/src" ]]; then
  SOURCE_DIR="${SCRIPT_DIR}"
else
  curl -fsSL "${REPO_TARBALL_URL}" | tar -xzf - -C "${WORK_DIR}"
  SOURCE_DIR="$(find "${WORK_DIR}" -maxdepth 1 -type d -name 'arc-cli-*' | head -n 1)"
  if [[ -z "${SOURCE_DIR}" ]]; then
    echo "Failed to download arc-cli runtime snapshot." >&2
    exit 1
  fi
fi

mkdir -p "${ARC_HOME}" "${BIN_DIR}"
rm -rf "${APP_DIR}"
cp -R "${SOURCE_DIR}" "${APP_DIR}"

cd "${APP_DIR}"
npm install --omit=dev >/dev/null
chmod +x "${APP_DIR}/bin/arc.js"
ln -snf "${APP_DIR}/bin/arc.js" "${BIN_DIR}/arc"

# Skill file ships inside the installed app snapshot.
SKILL_FILE="${APP_DIR}/skill/SKILL.md"

install_agent_skills
merge_claude_desktop_mcp "${BIN_DIR}/arc"

if [[ -n "${PAYLOAD}" ]]; then
  "${BIN_DIR}/arc" auth bootstrap --payload "${PAYLOAD}"
fi

# Check PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo "  Add to your shell profile (~/.zshrc or ~/.bashrc):"
  echo ""
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
fi

echo "Arc installed."
echo "CLI: ${BIN_DIR}/arc"
echo "Config: ${ARC_HOME}/config.json"
echo "Skill fallback: ${HOME}/.config/arc/SKILL.md"
echo "Claude MCP: ${CLAUDE_CONFIG_PATH}"
echo
echo "Try:"
echo "  arc config show --json"
echo "  arc budgets list --json"
echo "  arc ui"
