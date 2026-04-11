import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import type { Schedule } from '../types.js';
import { validateId } from '../utils/validation.js';
import { validateDate } from '../utils/validation.js';

export async function listSchedules(client: ActualClient): Promise<Schedule[]> {
  client.ensureConnected();
  return await client.api.getSchedules();
}

export async function createSchedule(
  client: ActualClient,
  writer: SafeWriter,
  schedule: Partial<Schedule>
): Promise<string> {
  if (!schedule.date && !schedule.next_date) {
    throw new Error('Schedule requires a date or next_date.');
  }

  const result = await writer.write(
    `Create schedule: ${schedule.name || 'unnamed'}`,
    () => client.api.createSchedule(schedule as any)
  );

  if (!result.success) throw new Error(result.error);
  return result.data;
}

export async function updateSchedule(
  client: ActualClient,
  writer: SafeWriter,
  id: string,
  fields: Partial<Schedule>
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Update schedule: ${id}`,
    () => client.api.updateSchedule(id, fields as any)
  );

  if (!result.success) throw new Error(result.error);
}

export async function deleteSchedule(
  client: ActualClient,
  writer: SafeWriter,
  id: string
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Delete schedule: ${id}`,
    () => client.api.deleteSchedule(id)
  );

  if (!result.success) throw new Error(result.error);
}

/**
 * Post a scheduled transaction — creates the actual transaction from the schedule.
 */
export async function postSchedule(
  client: ActualClient,
  writer: SafeWriter,
  scheduleId: string,
  date?: string
): Promise<string> {
  validateId(scheduleId);

  const schedules = await listSchedules(client);
  const schedule = schedules.find((s: any) => s.id === scheduleId);
  if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);

  const txDate = date || (schedule as any).next_date || new Date().toISOString().slice(0, 10);
  if (date) validateDate(date);

  const tx: any = {
    date: txDate,
    amount: (schedule as any)._amount || (schedule as any).amount || 0,
    payee: (schedule as any)._payee || (schedule as any).payee || undefined,
    category: (schedule as any)._category || (schedule as any).category || undefined,
    account: (schedule as any)._account || (schedule as any).account || undefined,
    notes: `Posted from schedule: ${(schedule as any).name || scheduleId}`,
    schedule: scheduleId,
    cleared: false,
  };

  if (!tx.account) throw new Error('Schedule has no account. Cannot post.');

  const result = await writer.write(
    `Post schedule: ${(schedule as any).name || scheduleId} on ${txDate}`,
    () => client.api.addTransactions(tx.account, [{
      date: tx.date, amount: tx.amount, payee: tx.payee,
      category: tx.category, notes: tx.notes, schedule: tx.schedule, cleared: tx.cleared,
    }])
  );

  if (!result.success) throw new Error(result.error);
  return result.data?.[0] || '';
}

/**
 * Get upcoming scheduled transactions (not completed, with next_date).
 */
export async function getUpcomingSchedules(client: ActualClient): Promise<any[]> {
  client.ensureConnected();
  const all = await listSchedules(client);
  return all
    .filter((s: any) => !s.completed && s.next_date)
    .sort((a: any, b: any) => (a.next_date || '').localeCompare(b.next_date || ''));
}

/**
 * Stop a schedule from generating new occurrences.
 *
 * Actual's API has no way to flip the `completed` flag from a client —
 * `completed` is system-managed and `updateSchedule` rejects it with
 * "Field completed is system-managed and not user-editable." The only
 * way for a user to make a schedule stop generating is to delete it,
 * which is what this function does. The deletion is logged so the
 * intent is auditable.
 *
 * This is observably equivalent to "marking complete" — both produce a
 * schedule that no longer appears in `arc schedules list` or generates
 * new transactions. If you want to keep the schedule record around but
 * pause it, use `arc schedules update` to set the recurrence endDate
 * to today.
 */
export async function completeSchedule(
  client: ActualClient,
  writer: SafeWriter,
  id: string
): Promise<void> {
  validateId(id);
  const result = await writer.write(
    `Complete schedule (deletes the schedule): ${id}`,
    () => client.api.deleteSchedule(id)
  );
  if (!result.success) throw new Error(result.error);
}
