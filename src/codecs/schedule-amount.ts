/**
 * Schedule amount resolution — ported from the arc app's
 * `services/recurringScheduleAmount.ts`.
 *
 * Actual stores a schedule's amount in several shapes depending on how the
 * schedule was created: raw cents, a JSON string, an `N:`-prefixed string, a
 * `{ num }` wrapper, or — when the amount condition uses the `isbetween`
 * operator — a range object `{ num1, num2 }`.
 *
 * Actual displays the average of an `isbetween` range, so that is what we
 * resolve it to. Reading `schedule.amount` directly is wrong: for a range
 * schedule it yields an object, and posting that as a transaction amount
 * writes a corrupt row.
 *
 * Pure module — no client, no IO — so it unit-tests without mocks.
 */

export type ScheduleCondition = {
  field?: string;
  value?: unknown;
};

export type ConditionsInput = string | ScheduleCondition[] | null | undefined;

function parseJsonString(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Resolve any of Actual's amount encodings to integer cents, or null. */
export function parseScheduleAmountCentsValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('N:')) {
      return parseScheduleAmountCentsValue(trimmed.slice(2));
    }

    const parsed = parseJsonString(trimmed);
    if (parsed !== null) {
      const parsedAmount = parseScheduleAmountCentsValue(parsed);
      if (parsedAmount !== null) return parsedAmount;
    }

    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? Math.round(numeric) : null;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // `isbetween` range — Actual stores `{ num1, num2 }` and shows the average.
    if ('num1' in obj || 'num2' in obj) {
      const a = parseScheduleAmountCentsValue(obj.num1);
      const b = parseScheduleAmountCentsValue(obj.num2);
      if (a !== null && b !== null) return Math.round((a + b) / 2);
      if (a !== null) return a;
      if (b !== null) return b;
      return null;
    }
    if ('num' in obj) return parseScheduleAmountCentsValue(obj.num);
    if ('amount' in obj) return parseScheduleAmountCentsValue(obj.amount);
    if ('value' in obj) return parseScheduleAmountCentsValue(obj.value);
  }

  return null;
}

function parseConditions(conditions: ConditionsInput): ScheduleCondition[] {
  if (!conditions) return [];
  if (Array.isArray(conditions)) return conditions;
  const parsed = parseJsonString(conditions);
  return Array.isArray(parsed) ? parsed : [];
}

/** Pull the amount out of a schedule's rule conditions. */
export function extractScheduleAmountFromConditions(
  conditions: ConditionsInput
): number | null {
  const amountCondition = parseConditions(conditions).find(
    item => item?.field === 'amount'
  );
  return amountCondition
    ? parseScheduleAmountCentsValue(amountCondition.value)
    : null;
}

/** Resolved amount in cents, or null when the schedule carries none. */
export function getScheduleAmountCents(
  rawAmount: unknown,
  conditions?: ConditionsInput
): number | null {
  return (
    parseScheduleAmountCentsValue(rawAmount) ??
    extractScheduleAmountFromConditions(conditions)
  );
}

/** Resolved amount in cents, defaulting to 0. */
export function resolveScheduleAmountCents(
  rawAmount: unknown,
  conditions?: ConditionsInput
): number {
  return getScheduleAmountCents(rawAmount, conditions) ?? 0;
}
