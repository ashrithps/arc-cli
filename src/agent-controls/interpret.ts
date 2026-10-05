/**
 * One plain sentence per audit row.
 *
 * The server's audit keeps only enums, ids, counts and durations — never an
 * amount or a payee — so on its own it can say "Claude Code deleted a
 * transaction" and no more. This machine's journal keeps the plaintext for
 * what ran here, so when a row matches a journal entry the sentence gains it:
 * "Claude Code deleted a transaction · Swiggy ₹4,500". Rows from other
 * machines stay generic, which is the honest answer.
 *
 * The subject is the agent for what agents did and "You" for what was done
 * from the phone; the server's own acts (an expiry) are said without one.
 */
import type { JournalEntry } from './journal.js';
import type { AuditRowWire } from './wire.js';

/** Local plaintext for an audit row, from this machine's journal. */
export interface JournalNote {
  /** e.g. "Swiggy ₹4,500"; appended after a " · ". */
  summary?: string;
  hostname?: string;
}

/** The part of the CLI journal the timeline reads. */
export interface ActivityJournal {
  lookup(row: AuditRowWire): JournalNote | undefined;
}

/** How far a journal line may sit from the audit row it describes. */
const JOURNAL_MATCH_MS = 2 * 60 * 1000;

/**
 * The journal's lines as a lookup. A line is matched by its audit or request
 * id, else by op and agent to the nearest line written just before the row
 * (an `op.completed` row has its own id). Journal summaries lead with the op
 * ("Delete transaction · 4,500.00 · Swiggy"); the sentence already says that,
 * so only what follows is kept.
 */
export function journalLookup(entries: readonly JournalEntry[]): ActivityJournal {
  const byId = new Map<string, JournalEntry>();
  const byOp = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    if (e.auditId) byId.set(e.auditId, e);
    if (e.requestId) byId.set(e.requestId, e);
    const k = `${e.client}|${e.opId}`;
    byOp.set(k, [...(byOp.get(k) ?? []), e]);
  }
  const note = (e: JournalEntry): JournalNote => {
    const parts = (e.summary ?? '').split(' · ');
    const summary = parts.length > 1 ? parts.slice(1).join(' · ') : undefined;
    return { summary, hostname: e.hostname };
  };
  return {
    lookup(row) {
      const hit = byId.get(row.id) ?? (row.requestId ? byId.get(row.requestId) : undefined);
      if (hit) return note(hit);
      if (!row.opId || !row.client) return undefined;
      let best: JournalEntry | undefined;
      for (const e of byOp.get(`${row.client}|${row.opId}`) ?? []) {
        const d = row.at - e.at;
        if (d >= -5000 && d <= JOURNAL_MATCH_MS && (!best || Math.abs(d) < Math.abs(row.at - best.at))) best = e;
      }
      return best ? note(best) : undefined;
    },
  };
}

export interface MachineInfo { label?: string; hostname?: string; intendedClient?: string }

export interface InterpretContext {
  journal?: ActivityJournal;
  /** connectionId → what to call that machine. */
  connections?: Record<string, MachineInfo>;
}

// ── Agents ──────────────────────────────────────────────────────────────────

const CLIENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  'claude-web': 'Claude',
  chatgpt: 'ChatGPT',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  gemini: 'Gemini',
  windsurf: 'Windsurf',
  terminal: 'Terminal',
  remote: 'A remote agent',
  '*': 'Every agent',
};

export function clientName(client: string | undefined | null): string {
  if (!client) return 'An agent';
  const known = CLIENT_NAMES[client];
  if (known) return known;
  return client
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function machineName(row: Pick<AuditRowWire, 'connectionId'>, ctx: InterpretContext): string {
  const m = row.connectionId ? ctx.connections?.[row.connectionId] : undefined;
  return m?.label || m?.hostname || ctx.journal?.lookup(row as AuditRowWire)?.hostname || 'a machine';
}

// ── Operations ──────────────────────────────────────────────────────────────

/** [to …, …ed] for a verb, or a whole phrase pair for an op that reads badly generically. */
type Phrase = readonly [present: string, past: string];

const OP_PHRASES: Record<string, Phrase> = {
  'accounts.balance': ['check a balance', 'checked a balance'],
  'transactions.list': ['read transactions', 'read transactions'],
  'transactions.split': ['split a transaction', 'split a transaction'],
  'transactions.transfer': ['make a transfer', 'made a transfer'],
  'transactions.refund': ['mark a refund', 'marked a refund'],
  'transactions.unrefund': ['undo a refund', 'undid a refund'],
  'transactions.refunds': ['read refunds', 'read refunds'],
  'transactions.batch-categorize': ['categorise transactions in bulk', 'categorised transactions in bulk'],
  'payees.find-or-create': ['look up a payee', 'looked up a payee'],
  'payees.common': ['read frequent payees', 'read frequent payees'],
  'tags.apply': ['tag transactions', 'tagged transactions'],
  'tags.unapply': ['untag transactions', 'untagged transactions'],
  'schedules.post': ['post a scheduled transaction', 'posted a scheduled transaction'],
  'schedules.upcoming': ['read upcoming schedules', 'read upcoming schedules'],
  'schedules.complete': ['complete a schedule', 'completed a schedule'],
  'budgets.list': ['list budgets', 'listed budgets'],
  'budgets.months': ['list budget months', 'listed budget months'],
  'budgets.month': ['read a budget month', 'read a budget month'],
  'budgets.set-amount': ['set a budget amount', 'set a budget amount'],
  'budgets.set-carryover': ['change a carryover', 'changed a carryover'],
  'budgets.transfer': ['move money between categories', 'moved money between categories'],
  'budgets.income': ['read income', 'read income'],
  'budgets.summary': ['read the budget summary', 'read the budget summary'],
  'budgets.switch': ['switch budgets', 'switched budgets'],
  'goals.show': ['read a goal', 'read a goal'],
  'goals.contribute': ['contribute to a goal', 'contributed to a goal'],
  'goals.current': ['read the current goal', 'read the current goal'],
  'splits.balances': ['read split balances', 'read split balances'],
  'splits.settle': ['settle a split', 'settled a split'],
  'portfolio.holding': ['read a holding', 'read a holding'],
  'portfolio.trades': ['read trades', 'read trades'],
  'portfolio.summary': ['read the portfolio summary', 'read the portfolio summary'],
  'portfolio.accounts': ['read portfolio accounts', 'read portfolio accounts'],
  'server.wake': ['wake the server', 'woke the server'],
};

const VERBS: Record<string, Phrase> = {
  list: ['list', 'listed'],
  add: ['add', 'added'],
  create: ['create', 'created'],
  update: ['update', 'updated'],
  delete: ['delete', 'deleted'],
  remove: ['remove', 'removed'],
  close: ['close', 'closed'],
  reopen: ['reopen', 'reopened'],
  merge: ['merge', 'merged'],
  import: ['import', 'imported'],
  archive: ['archive', 'archived'],
  settle: ['settle', 'settled'],
  apply: ['apply', 'applied'],
  show: ['read', 'read'],
  read: ['read', 'read'],
  set: ['set', 'set'],
};

const NOUNS: Record<string, string> = {
  accounts: 'account',
  transactions: 'transaction',
  categories: 'category',
  payees: 'payee',
  tags: 'tag',
  rules: 'rule',
  schedules: 'schedule',
  budgets: 'budget',
  goals: 'goal',
  splits: 'split',
  portfolio: 'holding',
  server: 'server',
};

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

function plural(noun: string): string {
  if (noun.endsWith('y') && !/[aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/** "delete a transaction" / "deleted a transaction" for an op id. */
export function opPhrase(opId: string | undefined, tense: 'present' | 'past'): string {
  if (!opId) return tense === 'past' ? 'did something' : 'do something';
  const fixed = OP_PHRASES[opId];
  if (fixed) return tense === 'past' ? fixed[1] : fixed[0];
  const [group, sub = ''] = opId.split('.');
  if (group === 'query') {
    const what = sub.replace(/-/g, ' ');
    return tense === 'past' ? `ran a ${what} report` : `run a ${what} report`;
  }
  const noun = NOUNS[group] ?? group.replace(/s$/, '');
  const batch = sub.startsWith('batch-');
  const verb = VERBS[batch ? sub.slice(6) : sub];
  if (!verb) {
    const words = sub.replace(/-/g, ' ');
    return tense === 'past' ? `used ${group} ${words}` : `use ${group} ${words}`;
  }
  const v = tense === 'past' ? verb[1] : verb[0];
  if (sub === 'list') return `${v} ${plural(noun)}`;
  if (batch) return `${v} ${plural(noun)} in bulk`;
  return `${v} ${article(noun)}`;
}

/** "delete a transaction" from a request's `summaryEnum` ("delete:transaction"). */
export function summaryPhrase(summaryEnum: string | undefined, opId?: string): string {
  if (!summaryEnum) return opPhrase(opId, 'present');
  const [verb, noun] = summaryEnum.split(':');
  if (!noun) return opPhrase(opId, 'present');
  const plural = noun.endsWith('s') && !noun.endsWith('ss');
  return `${verb.replace(/[-_]/g, ' ')} ${plural ? noun.replace(/[-_]/g, ' ') : article(noun.replace(/[-_]/g, ' '))}`;
}

// ── Sentences ───────────────────────────────────────────────────────────────

const PRESETS: Record<string, string> = { full: 'Full access', standard: 'Standard', private: 'Private' };

export function presetName(p: string | undefined): string {
  return p ? PRESETS[p] ?? p : 'a preset';
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? noun : plural(noun)}`;
}

/** The trailing detail an op row earns: local plaintext, a result count, a failure. */
export function opTail(row: AuditRowWire, ctx: InterpretContext): string[] {
  const out: string[] = [];
  const note = ctx.journal?.lookup(row);
  if (note?.summary) out.push(note.summary);
  const d = row.detail ?? {};
  if (typeof d.resultCount === 'number' && row.risk === 'read') out.push(count(d.resultCount, 'result'));
  if (d.offline) out.push('offline');
  if (d.result === 'error') out.push(d.errorCode ? `failed · ${d.errorCode}` : 'failed');
  return out;
}

function withTail(head: string, tail: string[]): string {
  return [head, ...tail].join(' · ');
}

/** How an approval was given, for the nested line under the op it unlocked. */
export function approvalPhrase(row: AuditRowWire): string {
  const d = row.detail ?? {};
  const where =
    d.decidedVia === 'mac' ? 'with Touch ID on your Mac' : d.decidedVia ? 'on your phone' : 'by you';
  const scope =
    d.scope === 'minutes' ? `for ${d.scopeMinutes ?? 15} minutes` : d.scope === 'always' ? 'from now on' : 'once';
  const signed = row.signatureSha256 ? ' · signed' : '';
  return `approved ${where}${signed} · ${scope}`;
}

const DENY_REASONS: Record<string, string> = {
  paused: 'paused',
  client_blocked: 'agent blocked',
  op_override: 'your rule',
  group_override: 'your rule',
  preset: 'your rules',
  mac_risk: 'too risky for a Mac approval',
};

/**
 * One sentence for one row. `agentless` drops the agent from the front when
 * the caller has already said who (a session header).
 */
export function interpret(row: AuditRowWire, ctx: InterpretContext = {}, agentless = false): string {
  const agent = clientName(row.client);
  const subj = (rest: string) => (agentless ? cap(rest) : `${agent} ${rest}`);
  const machine = machineName(row, ctx);
  const d = row.detail ?? {};

  switch (row.kind) {
    case 'op.allowed':
    case 'op.completed':
    case 'request.consumed':
      return withTail(subj(opPhrase(row.opId, 'past')), opTail(row, ctx));
    case 'op.denied': {
      const why = d.reason ? DENY_REASONS[d.reason] ?? d.reason.replace(/_/g, ' ') : undefined;
      const note = ctx.journal?.lookup(row)?.summary;
      return withTail(subj(`tried to ${opPhrase(row.opId, 'present')}`), [
        ...(note ? [note] : []),
        why ? `refused · ${why}` : 'refused',
      ]);
    }
    case 'request.created':
      return withTail(subj(`asked to ${opPhrase(row.opId, 'present')}`), opTail(row, ctx));
    case 'request.approved':
      return `You approved ${agent}’s request · ${approvalPhrase(row).replace(/^approved /, '')}`;
    case 'request.denied':
      return `You denied ${agent}’s request to ${opPhrase(row.opId, 'present')}`;
    case 'request.expired':
      return `${agent}’s request to ${opPhrase(row.opId, 'present')} expired unanswered`;
    case 'request.cancelled':
      return subj(`withdrew its request to ${opPhrase(row.opId, 'present')}`);
    case 'grant.revoked':
      return `You took back ${agent}’s standing approval${row.group ? ` for ${row.group}` : ''}`;
    case 'mismatch': {
      const intended = row.connectionId ? ctx.connections?.[row.connectionId]?.intendedClient : undefined;
      return intended
        ? subj(`used the connection made for ${clientName(intended)}`)
        : subj('used a connection made for another agent');
    }
    case 'client.first_seen':
      return subj(`showed up on ${machine} for the first time`);
    case 'client.allowed':
      return `You allowed ${agent} on ${machine}`;
    case 'client.blocked':
      return `You blocked ${agent} on ${machine}`;
    case 'policy.changed': {
      const who = row.client && row.client !== '*' ? `${agent}’s` : `${machine}’s`;
      const to = d.toPreset ?? d.preset;
      const change = d.fromPreset && to && d.fromPreset !== to ? `${presetName(d.fromPreset)} → ${presetName(to)}` : to ? presetName(to) : '';
      return withTail(`You changed ${who} rules`, change ? [change] : []);
    }
    case 'connection.created':
      return `You started pairing ${machine}`;
    case 'connection.claimed':
      return `${machine === 'a machine' ? 'A machine' : machine} claimed the pairing code`;
    case 'connection.approved':
      return withTail(`You connected ${machine}`, d.preset ? [presetName(d.preset)] : []);
    case 'connection.denied':
      return `You turned down ${machine}`;
    case 'connection.renamed':
      return `You renamed ${machine}`;
    case 'connection.revoked':
      return `You disconnected ${machine}`;
    case 'connection.paused':
      return `You paused ${machine}`;
    case 'connection.resumed':
      return `You resumed ${machine}`;
    case 'connection.expired':
      return `The pairing code for ${machine} expired`;
    case 'approver.enrolled':
      return 'You added an approver device';
    case 'approver.revoked':
      return 'You removed an approver device';
    case 'notice.sent':
      return row.client ? `You were told ${agent} ${opPhrase(row.opId, 'past')}` : 'You were sent a notice';
    case 'offline.batch':
      return withTail(`${machine === 'a machine' ? 'A machine' : cap(machine)} reported work done offline`, typeof d.count === 'number' ? [count(d.count, 'action')] : []);
    default:
      return `${row.client ? agent : 'Agents'} · ${String(row.kind)}`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
