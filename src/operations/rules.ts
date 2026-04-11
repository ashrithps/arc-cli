import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import type { Rule } from '../types.js';
import { validateId } from '../utils/validation.js';

export async function listRules(client: ActualClient): Promise<Rule[]> {
  client.ensureConnected();
  return await client.api.getRules();
}

export async function getPayeeRules(client: ActualClient, payeeId: string): Promise<Rule[]> {
  client.ensureConnected();
  validateId(payeeId);
  return await client.api.getPayeeRules(payeeId);
}

export async function createRule(
  client: ActualClient,
  writer: SafeWriter,
  rule: Omit<Rule, 'id'>
): Promise<string> {
  if (!rule.conditions || rule.conditions.length === 0) {
    throw new Error('Rule must have at least one condition.');
  }
  if (!rule.actions || rule.actions.length === 0) {
    throw new Error('Rule must have at least one action.');
  }

  const validStages = ['pre', 'default', 'post'];
  if (rule.stage && !validStages.includes(rule.stage)) {
    throw new Error(`Invalid rule stage: "${rule.stage}". Must be: ${validStages.join(', ')}`);
  }

  const result = await writer.write(
    `Create rule (${rule.conditions.length} conditions, ${rule.actions.length} actions)`,
    () => client.api.createRule(rule as any)
  );

  if (!result.success) throw new Error(result.error);
  // @actual-app/api's createRule returns the full rule object, not a bare
  // id string. Normalize so the operation contract matches its declared
  // `Promise<string>` return type. Callers that need the full record can
  // call listRules() afterwards.
  const data = result.data;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && typeof (data as any).id === 'string') return (data as any).id;
  throw new Error('createRule did not return a recognizable id');
}

export async function updateRule(
  client: ActualClient,
  writer: SafeWriter,
  rule: Rule
): Promise<Rule> {
  validateId(rule.id);

  const result = await writer.write(
    `Update rule: ${rule.id}`,
    () => client.api.updateRule(rule as any)
  );

  if (!result.success) throw new Error(result.error);
  return result.data;
}

export async function deleteRule(
  client: ActualClient,
  writer: SafeWriter,
  id: string
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Delete rule: ${id}`,
    () => client.api.deleteRule(id)
  );

  if (!result.success) throw new Error(result.error);
}
