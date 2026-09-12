/**
 * Savings goals.
 *
 * A goal is an ordinary Actual account whose note carries a `#goal:` tag. The
 * arc app reads and writes the same tag on the same accounts, so all encoding
 * lives in `src/codecs/goal-tag.ts` and is byte-compatible with the app's.
 *
 * Money is integer cents throughout, matching the rest of arc.
 */
import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import {
  buildGoalTag,
  calculateGoalProgress,
  DEFAULT_GOAL_COLOR,
  DEFAULT_GOAL_ICON,
  mergeGoalTag,
  parseGoalAccountRow,
  type GoalBehavior,
  type GoalProgress,
  type ParsedGoalAccount,
} from '../codecs/goal-tag.js';
import { accountNoteId, mutateNote, readAllNotes } from './notes.js';
import { validateId } from '../utils/validation.js';

export interface Goal extends ParsedGoalAccount {
  accountName: string;
  /** Live account balance in cents. */
  balance: number;
  progress: GoalProgress;
}

/**
 * Sum an account's non-child transactions.
 *
 * The app reads this from its SQLite mirror with
 * `COALESCE(SUM(amount),0) ... WHERE is_parent = 0`; here it is the same sum
 * over the AQL ledger. Children are skipped so split legs are not counted
 * twice alongside their parent.
 */
async function accountBalance(client: ActualClient, accountId: string): Promise<number> {
  try {
    const txns = await client.api.getTransactions(accountId);
    let balance = 0;
    for (const t of txns) if (!t.is_child) balance += t.amount ?? 0;
    return balance;
  } catch {
    return 0;
  }
}

/** Every goal in the budget, newest-relevant first (current goal leads). */
export async function listGoals(
  client: ActualClient,
  options: { includeArchived?: boolean } = {}
): Promise<Goal[]> {
  client.ensureConnected();
  const [noteRows, accounts] = await Promise.all([
    readAllNotes(client),
    client.api.getAccounts(),
  ]);

  const noteById = new Map(noteRows.map(r => [r.id, r.note]));
  const goals: Goal[] = [];

  for (const account of accounts as any[]) {
    const note = noteById.get(accountNoteId(account.id)) ?? null;
    const parsed = parseGoalAccountRow({
      id: account.id,
      name: account.name,
      type: account.type,
      offbudget: account.offbudget,
      closed: account.closed,
      note,
    });
    if (!parsed) continue;
    if (parsed.isArchived && !options.includeArchived) continue;

    const balance = await accountBalance(client, account.id);
    goals.push({
      ...parsed,
      accountName: account.name,
      balance,
      progress: calculateGoalProgress(parsed, balance),
    });
  }

  goals.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return a.goalName.localeCompare(b.goalName);
  });
  return goals;
}

export async function getGoal(client: ActualClient, accountRef: string): Promise<Goal> {
  const goals = await listGoals(client, { includeArchived: true });
  const needle = accountRef.toLowerCase();
  const found = goals.find(
    g =>
      g.accountId === accountRef ||
      g.goalName.toLowerCase() === needle ||
      g.accountName.toLowerCase() === needle
  );
  if (!found) throw new Error(`Goal not found: ${accountRef}`);
  return found;
}

/** Resolve a goal reference to its account id, erroring if it is not a goal. */
async function resolveGoalAccountId(
  client: ActualClient,
  accountRef: string
): Promise<string> {
  return (await getGoal(client, accountRef)).accountId;
}

/**
 * Write a goal tag onto an account, preserving everything else in the note.
 * `changes` is merged over the account's existing goal, if it has one.
 */
async function writeGoal(
  client: ActualClient,
  writer: SafeWriter,
  accountId: string,
  label: string,
  next: {
    goalName: string;
    targetAmount: number;
    deadline: string | null;
    behavior: GoalBehavior;
    totalContributed: number;
    color: string;
    icon: string;
    isCurrent: boolean;
    isArchived: boolean;
  }
): Promise<void> {
  const tag = buildGoalTag(next);
  await mutateNote(client, writer, label, accountNoteId(accountId), current =>
    mergeGoalTag(current, tag)
  );
}

export async function createGoal(
  client: ActualClient,
  writer: SafeWriter,
  params: {
    account: string;
    name?: string;
    target: number;
    deadline?: string | null;
    behavior?: GoalBehavior;
    color?: string;
    icon?: string;
    current?: boolean;
  }
): Promise<Goal> {
  client.ensureConnected();
  const accounts = await client.api.getAccounts();
  const needle = params.account.toLowerCase();
  const account = (accounts as any[]).find(
    a => a.id === params.account || a.name?.toLowerCase() === needle
  );
  if (!account) throw new Error(`Account not found: ${params.account}`);

  const existing = await readAllNotes(client);
  const note = existing.find(r => r.id === accountNoteId(account.id))?.note ?? null;
  if (parseGoalAccountRow({ id: account.id, name: account.name, note })) {
    throw new Error(
      `Account "${account.name}" already has a goal. Use \`arc goals update\` instead.`
    );
  }

  if (params.current) await clearCurrentFlag(client, writer);

  await writeGoal(client, writer, account.id, `Create goal: ${params.name || account.name}`, {
    goalName: params.name || account.name,
    targetAmount: params.target,
    deadline: params.deadline ?? null,
    behavior: params.behavior ?? 'have_balance',
    totalContributed: 0,
    color: params.color ?? DEFAULT_GOAL_COLOR,
    icon: params.icon ?? DEFAULT_GOAL_ICON,
    isCurrent: !!params.current,
    isArchived: false,
  });

  return getGoal(client, account.id);
}

export async function updateGoal(
  client: ActualClient,
  writer: SafeWriter,
  accountRef: string,
  changes: Partial<{
    name: string;
    target: number;
    deadline: string | null;
    behavior: GoalBehavior;
    color: string;
    icon: string;
    contributed: number;
  }>
): Promise<Goal> {
  const goal = await getGoal(client, accountRef);
  await writeGoal(client, writer, goal.accountId, `Update goal: ${goal.goalName}`, {
    goalName: changes.name ?? goal.goalName,
    targetAmount: changes.target ?? goal.targetAmount,
    deadline: changes.deadline !== undefined ? changes.deadline : goal.deadline,
    behavior: changes.behavior ?? goal.behavior,
    totalContributed: changes.contributed ?? goal.totalContributed,
    color: changes.color ?? goal.color,
    icon: changes.icon ?? goal.icon,
    isCurrent: goal.isCurrent,
    isArchived: goal.isArchived,
  });
  return getGoal(client, goal.accountId);
}

/**
 * Record a contribution against a `set_aside` goal.
 *
 * `have_balance` goals track the account balance directly, so a contribution
 * would be meaningless — and silently accepting one would make the two goal
 * types disagree about what "funded" means.
 */
export async function contributeToGoal(
  client: ActualClient,
  writer: SafeWriter,
  accountRef: string,
  amount: number
): Promise<Goal> {
  const goal = await getGoal(client, accountRef);
  if (goal.behavior !== 'set_aside') {
    throw new Error(
      `Goal "${goal.goalName}" tracks its account balance (behavior: have_balance), ` +
      `so contributions are not tracked separately. Add a transaction to the account instead.`
    );
  }
  return updateGoal(client, writer, goal.accountId, {
    contributed: Math.max(0, goal.totalContributed + amount),
  });
}

/** Clear `current:1` from whichever goal currently holds it. */
async function clearCurrentFlag(client: ActualClient, writer: SafeWriter): Promise<void> {
  const goals = await listGoals(client, { includeArchived: true });
  for (const g of goals.filter(x => x.isCurrent)) {
    await writeGoal(client, writer, g.accountId, `Unset current goal: ${g.goalName}`, {
      goalName: g.goalName,
      targetAmount: g.targetAmount,
      deadline: g.deadline,
      behavior: g.behavior,
      totalContributed: g.totalContributed,
      color: g.color,
      icon: g.icon,
      isCurrent: false,
      isArchived: g.isArchived,
    });
  }
}

/** Spotlight one goal, or clear the spotlight entirely. */
export async function setCurrentGoal(
  client: ActualClient,
  writer: SafeWriter,
  accountRef: string | null
): Promise<Goal | null> {
  await clearCurrentFlag(client, writer);
  if (!accountRef) return null;

  const goal = await getGoal(client, accountRef);
  await writeGoal(client, writer, goal.accountId, `Set current goal: ${goal.goalName}`, {
    goalName: goal.goalName,
    targetAmount: goal.targetAmount,
    deadline: goal.deadline,
    behavior: goal.behavior,
    totalContributed: goal.totalContributed,
    color: goal.color,
    icon: goal.icon,
    isCurrent: true,
    isArchived: false,
  });
  return getGoal(client, goal.accountId);
}

async function setArchived(
  client: ActualClient,
  writer: SafeWriter,
  accountRef: string,
  archived: boolean
): Promise<Goal> {
  const goal = await getGoal(client, accountRef);
  await writeGoal(
    client,
    writer,
    goal.accountId,
    `${archived ? 'Archive' : 'Reopen'} goal: ${goal.goalName}`,
    {
      goalName: goal.goalName,
      targetAmount: goal.targetAmount,
      deadline: goal.deadline,
      behavior: goal.behavior,
      totalContributed: goal.totalContributed,
      color: goal.color,
      icon: goal.icon,
      // Archiving also drops the spotlight; a hidden current goal is a bug.
      isCurrent: archived ? false : goal.isCurrent,
      isArchived: archived,
    }
  );
  return getGoal(client, goal.accountId);
}

export function archiveGoal(client: ActualClient, writer: SafeWriter, ref: string) {
  return setArchived(client, writer, ref, true);
}

export function reopenGoal(client: ActualClient, writer: SafeWriter, ref: string) {
  return setArchived(client, writer, ref, false);
}

/**
 * Strip the `#goal:` tag from an account.
 *
 * The account, its balance and its transactions are untouched — this removes
 * the goal overlay only.
 */
export async function deleteGoal(
  client: ActualClient,
  writer: SafeWriter,
  accountRef: string
): Promise<{ accountId: string; goalName: string }> {
  const goal = await getGoal(client, accountRef);
  validateId(goal.accountId);
  await mutateNote(
    client,
    writer,
    `Delete goal: ${goal.goalName}`,
    accountNoteId(goal.accountId),
    current => mergeGoalTag(current, null)
  );
  return { accountId: goal.accountId, goalName: goal.goalName };
}
