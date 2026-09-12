/**
 * Savings-goal codec — ported from the arc app's
 * `utils/goalAccountClassification.ts` and `GoalService.buildGoalTag`.
 *
 * A goal is an ordinary Actual account whose **note** carries a `#goal:` tag:
 *
 *   #goal:{name}|target:{cents}|deadline:{YYYY-MM-DD}|behavior:{set_aside|have_balance}
 *   |contributed:{cents}|color:{#rrggbb}|icon:{name}|current:{0|1}|archived:{0|1}
 *
 * The app and the CLI write the same notes on the same budget, so the encoder
 * here must stay byte-identical to the app's — field order included. The
 * round-trip tests in tests/goal-tag.test.ts hold that line.
 *
 * Pure module — no client, no IO.
 */

export type GoalBehavior = 'set_aside' | 'have_balance';

export type GoalStatus =
  | 'on_track'
  | 'behind'
  | 'ahead'
  | 'completed'
  | 'overdue';

export interface GoalAccountRow {
  id: string;
  name: string;
  type?: string;
  offbudget?: boolean | number;
  closed?: boolean | number;
  note: string | null;
  /** Account balance in integer cents. */
  balanceCents?: number | null;
}

export interface ParsedGoalAccount {
  accountId: string;
  goalName: string;
  /** Integer cents. */
  targetAmount: number;
  deadline: string | null;
  behavior: GoalBehavior;
  /** Integer cents. */
  totalContributed: number;
  color: string;
  icon: string;
  isCurrent: boolean;
  isArchived: boolean;
}

export interface GoalProgress {
  /** Integer cents. set_aside -> contributed; have_balance -> live balance. */
  fundedAmount: number;
  targetAmount: number;
  /** 0-100, capped for display. */
  percentage: number;
  remainingAmount: number;
  daysRemaining: number | null;
  monthsRemaining: number | null;
  /** Integer cents needed per month to stay on track. */
  monthlyAmountNeeded: number | null;
  status: GoalStatus;
  expectedProgress: number;
}

/** Legacy goal accounts were identified by this name prefix, before the tag. */
export const GOAL_ACCOUNT_NAME_PREFIX = '🎯 ';

export const DEFAULT_GOAL_COLOR = '#00D632';
export const DEFAULT_GOAL_ICON = 'flag';

function positiveIntegerFromMatch(match: RegExpMatchArray | null): number | null {
  if (!match) return null;
  const value = parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

export function isGoalNote(note: string | null | undefined): boolean {
  return Boolean(note && /#goal:[^|]+/.test(note));
}

export function isLegacyGoalAccount(row: GoalAccountRow): boolean {
  return Boolean(
    !row.closed &&
    row.offbudget &&
    row.type === 'savings' &&
    row.name.trim().startsWith(GOAL_ACCOUNT_NAME_PREFIX)
  );
}

/** Decode an account row into a goal, or null when it is not one. */
export function parseGoalAccountRow(row: GoalAccountRow): ParsedGoalAccount | null {
  const note = row.note ?? '';
  const hasGoalNote = isGoalNote(note);
  const hasLegacySignal = isLegacyGoalAccount(row);

  if (!hasGoalNote && !hasLegacySignal) return null;

  const nameMatch = note.match(/#goal:([^|]+)/);
  const trimmedAccountName = row.name.trim();
  const fallbackName = trimmedAccountName.startsWith(GOAL_ACCOUNT_NAME_PREFIX)
    ? trimmedAccountName.slice(GOAL_ACCOUNT_NAME_PREFIX.length).trim()
    : trimmedAccountName;
  const goalName = nameMatch?.[1] || fallbackName || 'Unnamed Goal';

  const balanceCents = Math.max(0, row.balanceCents ?? 0);
  const targetAmount =
    positiveIntegerFromMatch(note.match(/\|target:(\d+)/)) ?? balanceCents;
  const contributedAmount =
    positiveIntegerFromMatch(note.match(/\|contributed:(\d+)/)) ?? 0;

  const deadlineMatch = note.match(/\|deadline:(\d{4}-\d{2}-\d{2})/);
  const behaviorMatch = note.match(/\|behavior:(set_aside|have_balance)/);
  const colorMatch = note.match(/\|color:(#[a-fA-F0-9]{6})/);
  const iconMatch = note.match(/\|icon:([^|]+)/);
  const currentMatch = note.match(/\|current:([01])/);
  const archivedMatch = note.match(/\|archived:([01])/);

  return {
    accountId: row.id,
    goalName,
    targetAmount,
    deadline: deadlineMatch?.[1] || null,
    behavior: (behaviorMatch?.[1] as GoalBehavior | undefined) || 'have_balance',
    totalContributed: contributedAmount,
    color: colorMatch?.[1] || DEFAULT_GOAL_COLOR,
    icon: iconMatch?.[1] || DEFAULT_GOAL_ICON,
    isCurrent: currentMatch?.[1] === '1',
    isArchived: archivedMatch?.[1] === '1',
  };
}

/**
 * Build the `#goal:` tag. Field order is part of the wire format — the app
 * writes exactly this sequence, so do not reorder.
 */
export function buildGoalTag(params: {
  goalName: string;
  targetAmount: number;
  deadline: string | null;
  behavior: GoalBehavior;
  totalContributed: number;
  color: string;
  icon: string;
  isCurrent: boolean;
  isArchived?: boolean;
}): string {
  return [
    `#goal:${params.goalName}`,
    `target:${params.targetAmount}`,
    `deadline:${params.deadline || ''}`,
    `behavior:${params.behavior}`,
    `contributed:${params.totalContributed}`,
    `color:${params.color}`,
    `icon:${params.icon}`,
    `current:${params.isCurrent ? '1' : '0'}`,
    `archived:${params.isArchived ? '1' : '0'}`,
  ].join('|');
}

/**
 * Replace the `#goal:` tag in a note, preserving every other line.
 *
 * Account notes are shared with other arc features (`#debt|`) and with
 * whatever the user typed, so a goal write must never rewrite the whole body.
 * Passing `null` removes the goal tag and leaves the rest intact.
 */
export function mergeGoalTag(
  note: string | null | undefined,
  tag: string | null
): string {
  const lines = (note ?? '').split('\n');
  const kept = lines.filter(line => !isGoalNote(line));
  if (tag) kept.push(tag);
  return kept.join('\n').replace(/^\n+|\n+$/g, '');
}

// ── Progress ────────────────────────────────────────────────────────────────

function monthsBetween(startDate: Date, endDate: Date): number {
  const months =
    (endDate.getFullYear() - startDate.getFullYear()) * 12 +
    (endDate.getMonth() - startDate.getMonth());
  const startDay = startDate.getDate();
  const endDay = endDate.getDate();
  const daysInMonth = new Date(
    endDate.getFullYear(),
    endDate.getMonth() + 1,
    0
  ).getDate();
  const fractionalMonth = (endDay - startDay) / daysInMonth;
  return Math.max(0, months + fractionalMonth);
}

function daysBetween(startDate: Date, endDate: Date): number {
  const diffTime = endDate.getTime() - startDate.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Progress for one goal. `currentBalance` is the account's live balance in
 * cents; it is only consulted for `have_balance` goals.
 *
 * `now` is injectable so the status thresholds can be tested deterministically.
 */
export function calculateGoalProgress(
  goal: ParsedGoalAccount,
  currentBalance: number,
  now: Date = new Date()
): GoalProgress {
  const fundedAmount =
    goal.behavior === 'set_aside' ? goal.totalContributed : currentBalance;

  const targetAmount = goal.targetAmount;
  const percentage = targetAmount > 0 ? (fundedAmount / targetAmount) * 100 : 0;
  const remainingAmount = Math.max(0, targetAmount - fundedAmount);

  let daysRemaining: number | null = null;
  let monthsRemaining: number | null = null;
  let monthlyAmountNeeded: number | null = null;
  let expectedProgress = 0;

  if (goal.deadline) {
    const deadlineDate = new Date(goal.deadline);
    daysRemaining = daysBetween(now, deadlineDate);
    monthsRemaining = monthsBetween(now, deadlineDate);

    if (monthsRemaining > 0 && remainingAmount > 0) {
      monthlyAmountNeeded = Math.ceil(remainingAmount / monthsRemaining);
    } else if (remainingAmount > 0) {
      monthlyAmountNeeded = remainingAmount;
    }

    // Goals do not record a start date, so elapsed time is inferred from how
    // much of the target is already funded. Same approximation as the app.
    if (daysRemaining !== null && daysRemaining >= 0) {
      const fundedPortion = targetAmount > 0 ? fundedAmount / targetAmount : 0;
      const estimatedElapsedDays =
        fundedPortion > 0 && fundedPortion < 1
          ? (daysRemaining * fundedPortion) / (1 - fundedPortion)
          : 0;
      const totalEstimatedDays = daysRemaining + estimatedElapsedDays;
      if (totalEstimatedDays > 0) {
        expectedProgress =
          ((totalEstimatedDays - daysRemaining) / totalEstimatedDays) * 100;
      }
    }
  }

  let status: GoalStatus;
  if (percentage >= 100) {
    status = 'completed';
  } else if (goal.deadline && daysRemaining !== null && daysRemaining < 0) {
    status = 'overdue';
  } else if (percentage >= expectedProgress + 5) {
    status = 'ahead';
  } else if (expectedProgress > 0 && percentage < expectedProgress - 5) {
    status = 'behind';
  } else {
    status = 'on_track';
  }

  return {
    fundedAmount,
    targetAmount,
    percentage: Math.min(percentage, 100),
    remainingAmount,
    daysRemaining,
    monthsRemaining,
    monthlyAmountNeeded,
    status,
    expectedProgress,
  };
}
