/**
 * Which agent is on the other end. Ported from vault-cli `src/core/client.ts`.
 *
 * The phone shows an agent as (machine, client) — "Claude Code on
 * ashrith-mbp" — so every authorize call, grant and audit row carries a
 * normalised client key. The key list is fixed by the contract (§2); the app
 * maps the same keys to marks and display names, so an unrecognised spelling
 * here shows up there as a stranger.
 *
 * The machine is the cryptographic boundary; the client is policy. Any
 * process on this machine could claim any name, and the app says so.
 */

export interface ClientIdentity {
  /** Normalised key: one of the contract's, or `^[a-z0-9][a-z0-9._-]{0,63}$`. */
  key: string;
  display: string;
  /** What the client called itself, when that differs from `key`. */
  raw?: string;
}

const KNOWN: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  'claude-web': 'Claude.ai',
  chatgpt: 'ChatGPT',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  gemini: 'Gemini',
  windsurf: 'Windsurf',
  terminal: 'Terminal',
  remote: 'Remote agent',
};

/** The contract's client keys, in table order. */
export const CLIENT_KEYS = Object.keys(KNOWN);

export function clientDisplay(key: string): string {
  return KNOWN[key] ?? key;
}

function known(key: string, raw?: string): ClientIdentity {
  return raw && raw !== key ? { key, display: KNOWN[key], raw } : { key, display: KNOWN[key] };
}

/** Contract §2: lowercase, spaces → `-`, everything outside the alphabet stripped. */
export function normaliseClientKey(name: string): string | null {
  const key = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64);
  return key ? key : null;
}

/**
 * The agent a connection is set up for (`auth pair --agent`), or null for
 * "any agent on this machine". Unknown keys are refused rather than
 * slugified: a typo here would tag the connection with a client that never calls.
 */
export function parseIntendedClient(value: string | undefined | null): ClientIdentity | null {
  const key = (value ?? '').trim().toLowerCase();
  if (!key || key === 'any') return null;
  if (!(key in KNOWN)) {
    throw new Error(`Unknown agent "${value}". Use one of: ${CLIENT_KEYS.join(', ')} (or "any").`);
  }
  return known(key);
}

/**
 * Normalise an MCP `clientInfo.name`. `remote` is true for `arc mcp --http`,
 * where a bare "claude" is Claude.ai's connector, not the desktop app.
 */
export function normalizeClientName(name: string | undefined | null, remote = false): ClientIdentity | null {
  const raw = (name ?? '').trim();
  if (!raw) return null;
  const n = raw.toLowerCase();

  // Order matters: "claude-code" contains "claude", "codex" is checked before
  // the generic OpenAI names, and "copilot" before "vscode".
  if (n.includes('claude-code') || n.includes('claude code')) return known('claude-code', raw);
  if (n.includes('claude')) return known(remote ? 'claude-web' : 'claude-desktop', raw);
  if (n.includes('codex')) return known('codex', raw);
  if (n.includes('openai') || n.includes('chatgpt')) return known('chatgpt', raw);
  if (n.includes('cursor')) return known('cursor', raw);
  if (n.includes('copilot') || n.includes('vscode') || n.includes('visual studio code')) return known('copilot', raw);
  if (n.includes('gemini')) return known('gemini', raw);
  if (n.includes('windsurf')) return known('windsurf', raw);

  const key = normaliseClientKey(raw);
  if (!key) return null;
  if (key in KNOWN) return known(key, raw);
  return { key, display: raw, raw };
}

/** For CLI commands, the TUI, and MCP clients that send no clientInfo. */
export function detectClientFromEnv(env: NodeJS.ProcessEnv = process.env): ClientIdentity {
  const has = (prefix: string) => Object.keys(env).some(k => k.startsWith(prefix));
  if (env.ARC_AGENT) {
    const explicit = normalizeClientName(env.ARC_AGENT);
    if (explicit) return explicit;
  }
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return known('claude-code');
  if (has('CURSOR_')) return known('cursor');
  if (has('CODEX_')) return known('codex');
  if (env.GEMINI_CLI) return known('gemini');
  return known('terminal');
}

/**
 * The client for an MCP call: an explicit `--agent` tag first (the operator
 * said so, and a stateless HTTP server never sees the client's `initialize`),
 * then the call's own clientInfo, then the environment, and for a remote
 * server with nothing else to go on, `remote`.
 */
export function resolveClient(
  clientInfoName: string | undefined | null,
  options: { remote?: boolean; agentFlag?: string; env?: NodeJS.ProcessEnv } = {}
): ClientIdentity {
  if (options.agentFlag) {
    const tagged = normalizeClientName(options.agentFlag, options.remote);
    if (tagged) return tagged;
  }
  const fromInfo = normalizeClientName(clientInfoName, options.remote);
  if (fromInfo) return fromInfo;
  if (options.remote) return known('remote');
  return detectClientFromEnv(options.env);
}
