/**
 * Which registry operation a CLI command line is, and the args it hashes as.
 *
 * The CLI dispatcher (`executeParsedCommand`) never consults the registry,
 * so the gate needs this map to know what it is approving. Three outcomes:
 *
 * - a registry op, matched on group + subcommand or alias;
 * - `exempt`: commands that are not data operations at all (help, auth,
 *   session, mcp — which gates per tool — the approvals/activity commands);
 * - a synthetic op for a data command the registry does not know. It is
 *   classed `destructive`, so anything added to the dispatcher without a
 *   registry entry asks first rather than slipping through ungated.
 *
 * The args are built in the MCP shape (contract §4.3): the registry's
 * snake_case keys, coerced by the zod schema the MCP tool would use. Flags
 * the schema does not know are kept too, snake_cased, so the phone sees
 * every input that will change what runs — the hash covers what executes,
 * not just what the schema expected.
 */
import type { ZodTypeAny } from 'zod';
import { PUBLIC_OPERATIONS } from '../public-surface/operation-registry.js';
import type { PublicOperation } from '../public-surface/registry-types.js';

export interface ParsedCommand {
  command: string;
  subcommand: string;
  flags: Record<string, string>;
  positional: string[];
}

/** Not data operations. Each is either harmless or gated somewhere else. */
export const CLI_EXEMPT_COMMANDS: Readonly<Record<string, string>> = {
  help: 'prints usage',
  version: 'prints the installed version',
  update: 'reinstalls arc from the published installer',
  wake: 'pings the server until it answers; reads no budget data',
  server: 'only `server wake`, as above',
  backup: 'lists or prunes local backup files',
  session: 'starts and stops the local daemon; each command sent to it is gated here first',
  auth: 'pairing and bootstrap; needs the phone or a payload from it',
  config: 'shows the config with secrets redacted',
  ui: 'the TUI gates each write itself (surface "tui")',
  mcp: 'the MCP server gates each tool call itself (surface "mcp")',
  approvals: 'lists and decides requests; approving needs Touch ID',
  activity: 'reads this machine\'s activity timeline',
  agents: 'shows this connection and its permissions',
  agent: 'the CLI form of the `agent` group, which is never gated',
};

/** Data commands outside the registry that do the same thing as a registry op. */
export const CLI_OPERATION_ALIASES: Readonly<Record<string, string>> = {
  files: 'budgets.list',
  connect: 'accounts.list',
  doctor: 'accounts.list',
};

export type CliOperation =
  | { kind: 'exempt'; reason: string }
  | { kind: 'op'; op: PublicOperation; synthetic: boolean };

const BY_ID = new Map(PUBLIC_OPERATIONS.map(op => [op.id, op]));

export function findOperation(group: string, subcommand: string): PublicOperation | undefined {
  return PUBLIC_OPERATIONS.find(op =>
    op.group === group && (op.subcommand === subcommand || op.aliases?.includes(subcommand))
  );
}

export function operationById(id: string): PublicOperation | undefined {
  return BY_ID.get(id);
}

export function resolveCliOperation(parsed: Pick<ParsedCommand, 'command' | 'subcommand'>): CliOperation {
  const { command, subcommand } = parsed;
  if (command in CLI_EXEMPT_COMMANDS) return { kind: 'exempt', reason: CLI_EXEMPT_COMMANDS[command] };
  const aliased = CLI_OPERATION_ALIASES[command];
  if (aliased) return { kind: 'op', op: BY_ID.get(aliased)!, synthetic: false };
  const op = findOperation(command, subcommand);
  if (op) return { kind: 'op', op, synthetic: false };
  return {
    kind: 'op',
    synthetic: true,
    op: {
      id: `cli.${command}.${subcommand}`,
      group: command as PublicOperation['group'],
      subcommand,
      mcpTool: '',
      mode: 'write',
      risk: 'destructive',
      description: `Unregistered CLI command \`arc ${command} ${subcommand}\``,
      examples: [],
      inputSchema: {},
      defaultExposure: 'advanced',
    },
  };
}

// ── argv → MCP-shaped args ──────────────────────────────────────────────────

/** Flags that select where a command runs rather than what it does; `budget` is hashed separately. */
const CONTEXT_FLAGS = new Set(['budget', 'help']);

function zodKind(schema: ZodTypeAny | undefined): string {
  let s: any = schema;
  for (let i = 0; s && i < 8; i++) {
    const def = s._zod?.def ?? s.def ?? s._def;
    const type: string | undefined = def?.type ?? def?.typeName;
    if (type === 'optional' || type === 'nullable' || type === 'default' || type === 'ZodOptional' ||
        type === 'ZodNullable' || type === 'ZodDefault' || type === 'pipe' || type === 'readonly') {
      s = def.innerType ?? def.in;
      continue;
    }
    return (type ?? 'unknown').replace(/^Zod/, '').toLowerCase();
  }
  return 'unknown';
}

function coerce(kind: string, raw: string): unknown {
  switch (kind) {
    case 'number':
    case 'int': {
      const n = Number(raw);
      return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : raw;
    case 'array':
    case 'object':
    case 'record':
    case 'union':
    case 'any':
    case 'unknown':
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

const snake = (key: string) => key.replace(/-/g, '_');

export function argsFromArgv(op: PublicOperation, parsed: ParsedCommand): Record<string, unknown> {
  const shape = op.inputSchema as Record<string, ZodTypeAny>;
  const args: Record<string, unknown> = {};
  const consumed = new Set<string>();

  for (const key of Object.keys(shape)) {
    const flagNames = [key, key.replace(/_/g, '-')];
    const flag = flagNames.find(name => parsed.flags[name] !== undefined);
    if (flag === undefined) continue;
    consumed.add(flag);
    args[key] = coerce(zodKind(shape[key]), parsed.flags[flag]);
  }

  const positional = [...parsed.positional];
  if ('data' in shape && args.data === undefined && positional.length > 0) {
    args.data = coerce(zodKind(shape.data), positional.shift()!);
  }

  for (const [flag, value] of Object.entries(parsed.flags)) {
    if (consumed.has(flag) || CONTEXT_FLAGS.has(flag)) continue;
    const key = snake(flag);
    if (key in args) continue;
    args[key] = value;
  }
  if (positional.length > 0) args._positional = positional;
  return args;
}
