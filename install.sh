#!/usr/bin/env bash
set -euo pipefail

ARC_HOME="${HOME}/.arc-cli"
APP_DIR="${ARC_HOME}/app"
BIN_DIR="${HOME}/.local/bin"
SKILL_DIR="${HOME}/.codex/skills/arc"
CLAUDE_CONFIG_DIR="${HOME}/Library/Application Support/Claude"
CLAUDE_CONFIG_PATH="${CLAUDE_CONFIG_DIR}/claude_desktop_config.json"
REPO_TARBALL_URL="${ARC_CLI_TARBALL_URL:-https://codeload.github.com/ashrithgovind/arc-cli/tar.gz/refs/heads/main}"

PAYLOAD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --payload)
      PAYLOAD="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd npm
need_cmd curl

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

if [[ -f "${SCRIPT_DIR}/package.json" && -f "${SCRIPT_DIR}/bin/arc.js" && -d "${SCRIPT_DIR}/src" ]]; then
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

mkdir -p "${SKILL_DIR}"
cp "${APP_DIR}/skill/SKILL.md" "${SKILL_DIR}/SKILL.md"

mkdir -p "${CLAUDE_CONFIG_DIR}"
node - "${CLAUDE_CONFIG_PATH}" "${BIN_DIR}/arc" <<'NODE'
const fs = require('fs');
const path = require('path');

const [configPath, arcPath] = process.argv.slice(2);
let config = {};

if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    config = {};
  }
}

if (!config.mcpServers || typeof config.mcpServers !== 'object') {
  config.mcpServers = {};
}

config.mcpServers.arc = {
  command: arcPath,
  args: ['mcp']
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
NODE

if [[ -n "${PAYLOAD}" ]]; then
  "${BIN_DIR}/arc" auth bootstrap --payload "${PAYLOAD}"
fi

echo "Arc installed."
echo "CLI: ${BIN_DIR}/arc"
echo "Config: ${ARC_HOME}/config.json"
echo "Skill: ${SKILL_DIR}/SKILL.md"
echo "Claude MCP: ${CLAUDE_CONFIG_PATH}"
echo
echo "Try:"
echo "  arc config show --json"
echo "  arc budgets list --json"
echo "  arc ui"
