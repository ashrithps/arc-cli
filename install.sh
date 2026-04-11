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

# ─── Pretty output ──────────────────────────────────────────────────────────
# Detect a terminal with colour support. Degrades to plain text when piped to
# a file or a non-colour TTY so grep-based tests and CI logs stay readable.
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD="$(tput bold)"
  DIM="$(tput dim)"
  RED="$(tput setaf 1)"
  GREEN="$(tput setaf 2)"
  YELLOW="$(tput setaf 3)"
  BLUE="$(tput setaf 4)"
  CYAN="$(tput setaf 6)"
  RESET="$(tput sgr0)"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; RESET=""
fi

section() { printf "\n%s▸%s %s%s%s\n" "${BOLD}${BLUE}" "${RESET}" "${BOLD}" "$1" "${RESET}"; }
ok()      { printf "  %s✓%s %s\n" "${GREEN}" "${RESET}" "$1"; }
warn()    { printf "  %s!%s %s\n" "${YELLOW}" "${RESET}" "$1"; }
fail()    { printf "  %s✗%s %s\n" "${RED}" "${RESET}" "$1" >&2; }
info()    { printf "  %s%s%s\n" "${DIM}" "$1" "${RESET}"; }

banner_top() {
  printf "\n"
  printf "  %s╭──────────────────────╮%s\n" "${BOLD}${CYAN}" "${RESET}"
  printf "  %s│%s  %sArc CLI installer%s  %s│%s\n" "${BOLD}${CYAN}" "${RESET}" "${BOLD}" "${RESET}" "${BOLD}${CYAN}" "${RESET}"
  printf "  %s╰──────────────────────╯%s\n" "${BOLD}${CYAN}" "${RESET}"
}

banner_done() {
  printf "\n"
  printf "  %s╭──────────────────────╮%s\n" "${BOLD}${GREEN}" "${RESET}"
  printf "  %s│%s   %s✓ Arc installed%s    %s│%s\n" "${BOLD}${GREEN}" "${RESET}" "${BOLD}" "${RESET}" "${BOLD}${GREEN}" "${RESET}"
  printf "  %s╰──────────────────────╯%s\n" "${BOLD}${GREEN}" "${RESET}"
}

# ─── Helpers ────────────────────────────────────────────────────────────────

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
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
  ok "$name → $dir"
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
  ok "fallback → ~/.config/arc/SKILL.md"

  # Summary line retained verbatim so tests that grep it keep working.
  if [ -n "$SKILL_INSTALLED" ]; then
    info "Agent skills installed:$SKILL_INSTALLED"
  else
    info "Skill file at: ~/.config/arc/SKILL.md"
  fi
}

# merge_claude_desktop_mcp ARC_BIN
#   Adds an `arc` entry under mcpServers without dropping existing entries.
merge_claude_desktop_mcp() {
  local arc_bin="$1"
  if [ ! -d "$HOME/Library/Application Support/Claude" ]; then
    info "Claude Desktop not detected — skipping MCP merge"
    return 0
  fi
  mkdir -p "$CLAUDE_CONFIG_DIR"
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found — skipping Claude Desktop MCP merge"
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
  ok "merged arc into claude_desktop_config.json"
}

# ─── Skills-only mode ───────────────────────────────────────────────────────
# Used by tests/installer-parity.test.ts to exercise the skill matrix against
# a temp HOME without running npm or hitting the network.

if [[ "$SKILLS_ONLY" -eq 1 ]]; then
  if [[ -z "$SKILL_FILE_OVERRIDE" ]]; then
    fail "--skills-only requires --skill-file <path>"
    exit 2
  fi
  SKILL_FILE="$SKILL_FILE_OVERRIDE"
  if [[ ! -f "$SKILL_FILE" ]]; then
    fail "Skill file not found: $SKILL_FILE"
    exit 2
  fi
  section "Installing agent skills"
  install_agent_skills
  section "Claude Desktop MCP"
  merge_claude_desktop_mcp "${BIN_DIR}/arc"
  exit 0
fi

# ─── Full install ───────────────────────────────────────────────────────────

banner_top

section "Preflight"
need_cmd node
NODE_VERSION="$(node --version)"
NODE_MAJOR="$(printf '%s' "${NODE_VERSION}" | sed -E 's/^v([0-9]+)\..*/\1/')"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  fail "Arc requires Node 18 or newer. Detected ${NODE_VERSION}."
  info "Install a newer node (e.g. via mise, nvm, asdf, or nodejs.org) and retry."
  exit 1
fi
ok "node ${NODE_VERSION}"
need_cmd npm  && ok "npm  $(npm --version)"
need_cmd curl && ok "curl $(curl --version | head -n1 | awk '{print $2}')"

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

section "Runtime source"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/package.json" && -f "${SCRIPT_DIR}/bin/arc.js" && -d "${SCRIPT_DIR}/src" ]]; then
  SOURCE_DIR="${SCRIPT_DIR}"
  ok "using local checkout: ${SCRIPT_DIR}"
else
  info "downloading ${REPO_TARBALL_URL}"
  curl -fsSL "${REPO_TARBALL_URL}" | tar -xzf - -C "${WORK_DIR}"
  SOURCE_DIR="$(find "${WORK_DIR}" -maxdepth 1 -type d -name 'arc-cli-*' | head -n 1)"
  if [[ -z "${SOURCE_DIR}" ]]; then
    fail "Failed to download arc-cli runtime snapshot."
    exit 1
  fi
  ok "extracted to ${WORK_DIR}"
fi

section "Installing runtime"
mkdir -p "${ARC_HOME}" "${BIN_DIR}"
rm -rf "${APP_DIR}"
cp -R "${SOURCE_DIR}" "${APP_DIR}"
ok "copied runtime to ${APP_DIR}"

cd "${APP_DIR}"
info "running npm install --omit=dev (this may take a moment)"
NPM_LOG="$(mktemp)"
if ! npm install --omit=dev >"${NPM_LOG}" 2>&1; then
  fail "npm install failed — output below:"
  cat "${NPM_LOG}" >&2
  rm -f "${NPM_LOG}"
  exit 1
fi
rm -f "${NPM_LOG}"
ok "dependencies installed"

chmod +x "${APP_DIR}/bin/arc.js"
ln -snf "${APP_DIR}/bin/arc.js" "${BIN_DIR}/arc"
ok "launcher at ${BIN_DIR}/arc"

# Skill file ships inside the installed app snapshot.
SKILL_FILE="${APP_DIR}/skill/SKILL.md"

section "Installing agent skills"
install_agent_skills

section "Claude Desktop MCP"
merge_claude_desktop_mcp "${BIN_DIR}/arc"

if [[ -n "${PAYLOAD}" ]]; then
  section "Bootstrapping budget"
  if "${BIN_DIR}/arc" auth bootstrap --payload "${PAYLOAD}" >/tmp/arc-bootstrap.log 2>&1; then
    ok "budget linked and credentials saved"
  else
    fail "auth bootstrap failed — see /tmp/arc-bootstrap.log"
    cat /tmp/arc-bootstrap.log >&2 || true
    exit 1
  fi
fi

banner_done

printf "\n"
printf "  %sCLI%s       %s\n" "${DIM}" "${RESET}" "${BIN_DIR}/arc"
printf "  %sConfig%s    %s\n" "${DIM}" "${RESET}" "${ARC_HOME}/config.json"
printf "  %sSkill%s     %s\n" "${DIM}" "${RESET}" "${HOME}/.config/arc/SKILL.md"
printf "  %sMCP%s       %s\n" "${DIM}" "${RESET}" "${CLAUDE_CONFIG_PATH}"
printf "\n"
printf "  %sTry:%s\n" "${BOLD}" "${RESET}"
printf "    arc config show --json\n"
printf "    arc budgets list --json\n"
printf "    arc ui\n"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  printf "\n"
  warn "${BIN_DIR} is not on your PATH."
  printf "    Add to ~/.zshrc or ~/.bashrc:\n"
  printf "      export PATH=\"\$HOME/.local/bin:\$PATH\"\n"
fi

printf "\n"
