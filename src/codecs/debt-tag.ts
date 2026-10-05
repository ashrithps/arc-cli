/**
 * Debt / EMI codec — ported from the arc app's `services/DebtTagService.ts`
 * (`parseDebtTag`, `buildDebtTag`, `mergeDebtTag`) and the "next payment due"
 * insight in `hooks/useSpendInsights.ts`.
 *
 * A debt is an ordinary Actual account (credit card, loan, EMI) whose **note**
 * carries one `#debt|` line:
 *
 *   #debt|due:{1-31}
 *
 * The app reads the due day to schedule its credit-card reminders. The app and
 * the CLI write the same notes on the same budget, so the encoder here must
 * stay byte-identical to the app's. The golden tests in tests/debt-tag.test.ts
 * hold that line.
 *
 * Pure module — no client, no IO.
 */

export interface DebtTag {
  /** Day of the month the payment is due, 1-31; null when the tag has none. */
  dueDay: number | null;
}

export const DEBT_TAG_PREFIX = '#debt|';

function findDebtLine(note: string | null | undefined): string | null {
  if (!note) return null;
  return (
    note
      .split('\n')
      .map(l => l.trim())
      .find(l => l.startsWith(DEBT_TAG_PREFIX)) ?? null
  );
}

export function isDebtNote(note: string | null | undefined): boolean {
  return findDebtLine(note) !== null;
}

/** Decode the `#debt|` line in a note, or null when there is none. */
export function parseDebtTag(note: string | null | undefined): DebtTag | null {
  const line = findDebtLine(note);
  if (!line) return null;

  const dueMatch = line.match(/\bdue:(\d{1,2})/);

  const dueDayRaw = dueMatch ? parseInt(dueMatch[1], 10) : null;
  const dueDay =
    dueDayRaw !== null && dueDayRaw >= 1 && dueDayRaw <= 31 ? dueDayRaw : null;

  return { dueDay };
}

/**
 * Build the `#debt|` line. Field order is part of the wire format — the app
 * writes exactly this sequence, so do not reorder.
 */
export function buildDebtTag(tag: DebtTag): string {
  return ['#debt', `due:${tag.dueDay ?? ''}`].join('|');
}

/**
 * Replace the `#debt|` line in an account note, keeping every other line.
 * Passing `null` removes the tag.
 *
 * Same normalisation as the app: every line is trimmed and blank lines are
 * dropped. That is the app's behaviour on every debt write, so matching it
 * keeps a CLI write and an app write of the same note identical. Returns ''
 * where the app returns null (an empty note); `notes-save` takes a string.
 */
export function mergeDebtTag(
  note: string | null | undefined,
  tag: DebtTag | null
): string {
  const baseLines = (note || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith(DEBT_TAG_PREFIX));

  if (tag) baseLines.push(buildDebtTag(tag));

  return baseLines.join('\n').trim();
}

export function isValidDueDay(day: unknown): day is number {
  return typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 31;
}

/**
 * Days until the next due day, as the app's "Next Payment Due" insight counts
 * them: a day already past this month rolls over by a flat 30 days. An
 * approximation, kept so the CLI and the app agree on the number.
 */
export function daysUntilDue(dueDay: number, now: Date = new Date()): number {
  let daysUntil = dueDay - now.getDate();
  if (daysUntil < 0) daysUntil += 30;
  return daysUntil;
}
