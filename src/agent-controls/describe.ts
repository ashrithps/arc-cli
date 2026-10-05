/**
 * What an operation is about to do, in words a person can approve.
 *
 * Two outputs with very different audiences:
 * - `summaryEnum` ("delete:transaction") travels in plaintext. The server
 *   builds the push title from it, so it is an enum and never data: no
 *   amounts, payees, names or notes.
 * - `summary` and `fields` are sealed to the user's key along with the args
 *   and only the phone can read them. They carry the specifics the user needs
 *   to decide: the amount, the payee, the account.
 */
import type { PublicOperation } from '../public-surface/registry-types.js';

type OpLike = Pick<PublicOperation, 'id' | 'group' | 'subcommand' | 'mode'>;

/** `<verb>:<noun>` for every write; reads are `read:<group noun>`. */
const WRITE_ENUMS: Record<string, string> = {
  'accounts.create': 'add:account',
  'accounts.update': 'update:account',
  'accounts.close': 'close:account',
  'accounts.reopen': 'reopen:account',
  'accounts.delete': 'delete:account',
  'transactions.add': 'add:transaction',
  'transactions.import': 'import:transactions',
  'transactions.update': 'update:transaction',
  'transactions.delete': 'delete:transaction',
  'transactions.split': 'add:split-transaction',
  'transactions.transfer': 'add:transfer',
  'transactions.batch-update': 'update:transactions',
  'transactions.batch-add': 'add:transactions',
  'transactions.batch-categorize': 'categorize:transactions',
  'transactions.refund': 'mark:refund',
  'transactions.unrefund': 'unmark:refund',
  'categories.create': 'add:category',
  'categories.update': 'update:category',
  'categories.delete': 'delete:category',
  'payees.create': 'add:payee',
  'payees.update': 'update:payee',
  'payees.delete': 'delete:payee',
  'payees.merge': 'merge:payees',
  'payees.find-or-create': 'add:payee',
  'tags.add': 'add:tag',
  'tags.update': 'update:tag',
  'tags.delete': 'delete:tag',
  'tags.apply': 'tag:transactions',
  'tags.unapply': 'untag:transactions',
  'rules.create': 'add:rule',
  'rules.update': 'update:rule',
  'rules.delete': 'delete:rule',
  'schedules.create': 'add:schedule',
  'schedules.update': 'update:schedule',
  'schedules.delete': 'delete:schedule',
  'schedules.post': 'post:schedule',
  'schedules.complete': 'complete:schedule',
  'budgets.set-amount': 'set:budget-amount',
  'budgets.set-carryover': 'set:carryover',
  'budgets.transfer': 'move:budget-money',
  'budgets.switch': 'switch:budget',
  'goals.create': 'add:goal',
  'goals.update': 'update:goal',
  'goals.contribute': 'contribute:goal',
  'goals.current': 'spotlight:goal',
  'goals.archive': 'archive:goal',
  'goals.reopen': 'reopen:goal',
  'goals.delete': 'delete:goal',
  'splits.create': 'add:split',
  'splits.settle': 'settle:split',
  'splits.reopen': 'reopen:split',
  'splits.remove': 'remove:split-person',
  'splits.delete': 'delete:split',
};

const READ_NOUNS: Record<string, string> = {
  accounts: 'accounts',
  transactions: 'transactions',
  categories: 'categories',
  payees: 'payees',
  tags: 'tags',
  rules: 'rules',
  schedules: 'schedules',
  budgets: 'budgets',
  query: 'reports',
  portfolio: 'portfolio',
  goals: 'goals',
  splits: 'splits',
  server: 'server',
  agent: 'permissions',
};

export function summaryEnumFor(op: OpLike): string {
  if (WRITE_ENUMS[op.id]) return WRITE_ENUMS[op.id];
  if (op.id === 'server.wake') return 'wake:server';
  if (op.mode === 'read') return `read:${READ_NOUNS[op.group] ?? 'data'}`;
  return 'run:command';
}

/** Every summaryEnum this CLI can send, for the app's push copy table. */
export function allSummaryEnums(ops: readonly OpLike[]): string[] {
  return [...new Set([...ops.map(summaryEnumFor), 'run:command'])].sort();
}

// ── sealed summary ──────────────────────────────────────────────────────────

const LABELS: Record<string, string> = {
  amount: 'Amount',
  foreign_amount: 'Foreign amount',
  balance: 'Balance',
  payee: 'Payee',
  payee_name: 'Payee',
  account: 'Account',
  from: 'From',
  to: 'To',
  transfer_to: 'Transfer to',
  date: 'Date',
  category: 'Category',
  notes: 'Notes',
  name: 'Name',
  id: 'Id',
  month: 'Month',
  goal: 'Goal',
  target: 'Target',
  person: 'Person',
  gid: 'Split',
  tag: 'Tag',
  tags: 'Tags',
  data: 'Items',
  updates: 'Items',
  transactions: 'Items',
  ids: 'Items',
  budget: 'Budget',
};

const HEADLINE_KEYS = ['amount', 'payee', 'payee_name', 'account', 'from', 'to', 'name', 'goal', 'category', 'date', 'id'];
const SKIP_KEYS = new Set(['json']);
/** Sealed along with the args (the hash needs them), but never displayed. */
const MASKED_KEYS = new Set(['password']);
const MAX_VALUE = 200;

function clip(text: string, max = MAX_VALUE): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatAmount(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function itemCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.length;
    } catch { /* not JSON; shown as text */ }
  }
  return null;
}

function formatValue(key: string, value: unknown): string {
  if (MASKED_KEYS.has(key)) return '••••••';
  if (typeof value === 'number' && /amount|balance|target/.test(key)) return formatAmount(value);
  const count = itemCount(value);
  if (count != null) return `${count} ${count === 1 ? 'item' : 'items'}`;
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value === null) return '—';
  return clip(JSON.stringify(value));
}

function labelFor(key: string): string {
  return LABELS[key] ?? key.replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());
}

export interface OperationDescription {
  summaryEnum: string;
  /** "Delete transaction · 4,500.00 · Swiggy" — sealed with the args, and kept in the local journal. */
  summary: string;
  /** The same without the action: "4,500.00 · Swiggy". The phone appends it to its own sentence. */
  specifics: string;
  fields: Array<{ label: string; value: string }>;
}

export function describeOperation(op: OpLike, args: Record<string, unknown>): OperationDescription {
  const summaryEnum = summaryEnumFor(op);
  const [verb, noun] = summaryEnum.split(':');
  const title = `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${noun.replace(/-/g, ' ')}`;

  const fields: Array<{ label: string; value: string }> = [];
  for (const [key, value] of Object.entries(args)) {
    if (SKIP_KEYS.has(key) || value === undefined || value === '') continue;
    fields.push({ label: labelFor(key), value: formatValue(key, value) });
  }

  const headline = HEADLINE_KEYS
    .filter(key => args[key] !== undefined && args[key] !== '')
    .slice(0, 3)
    .map(key => clip(formatValue(key, args[key]), 60));
  const items = Object.entries(args).map(([key, value]) => ({ key, count: itemCount(value) })).find(x => x.count != null);
  if (items && headline.length < 3) headline.push(`${items.count} ${items.count === 1 ? 'item' : 'items'}`);

  return { summaryEnum, summary: [title, ...headline].join(' · '), specifics: headline.join(' · '), fields };
}
