import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import type { Category, CategoryGroup } from '../types.js';
import { validateId, validateName } from '../utils/validation.js';

export async function listCategories(client: ActualClient): Promise<Category[]> {
  client.ensureConnected();
  const groups = await client.api.getCategoryGroups();
  const categories: Category[] = [];
  for (const group of groups) {
    for (const cat of (group as any).categories || []) {
      categories.push({
        ...cat,
        group_id: (group as any).id,
      });
    }
  }
  return categories;
}

export async function listCategoryGroups(client: ActualClient): Promise<CategoryGroup[]> {
  client.ensureConnected();
  return await client.api.getCategoryGroups();
}

export async function resolveCategoryGroupId(client: ActualClient, nameOrId: string): Promise<string> {
  const groups = await listCategoryGroups(client);

  const byId = groups.find(g => g.id === nameOrId);
  if (byId) return byId.id;

  const lower = nameOrId.toLowerCase();
  const byName = groups.find(g => g.name.toLowerCase() === lower);
  if (byName) return byName.id;

  const partial = groups.find(g => g.name.toLowerCase().includes(lower));
  if (partial) return partial.id;

  throw new Error(`Category group not found: "${nameOrId}". Available: ${groups.map(g => g.name).join(', ')}`);
}

export async function createCategory(
  client: ActualClient,
  writer: SafeWriter,
  name: string,
  groupId: string,
  isIncome?: boolean
): Promise<string> {
  validateName(name);
  validateId(groupId);

  const cat: any = { name, group_id: groupId };
  if (isIncome != null) cat.is_income = isIncome;

  const result = await writer.write(
    `Create category: ${name}`,
    () => client.api.createCategory(cat)
  );

  if (!result.success) throw new Error(result.error);
  return result.data;
}

export async function updateCategory(
  client: ActualClient,
  writer: SafeWriter,
  id: string,
  fields: Partial<Category>
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Update category: ${id}`,
    () => client.api.updateCategory(id, fields)
  );

  if (!result.success) throw new Error(result.error);
}

export async function deleteCategory(
  client: ActualClient,
  writer: SafeWriter,
  id: string,
  transferCategoryId?: string
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Delete category: ${id}`,
    () => client.api.deleteCategory(id, transferCategoryId)
  );

  if (!result.success) throw new Error(result.error);
}

export async function createCategoryGroup(
  client: ActualClient,
  writer: SafeWriter,
  name: string,
  isIncome?: boolean
): Promise<string> {
  validateName(name);

  const group: any = { name };
  if (isIncome != null) group.is_income = isIncome;

  const result = await writer.write(
    `Create category group: ${name}`,
    () => client.api.createCategoryGroup(group)
  );

  if (!result.success) throw new Error(result.error);
  return result.data;
}

export async function updateCategoryGroup(
  client: ActualClient,
  writer: SafeWriter,
  id: string,
  fields: Partial<CategoryGroup>
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Update category group: ${id}`,
    () => client.api.updateCategoryGroup(id, fields)
  );

  if (!result.success) throw new Error(result.error);
}

export async function deleteCategoryGroup(
  client: ActualClient,
  writer: SafeWriter,
  id: string,
  transferGroupId?: string
): Promise<void> {
  validateId(id);

  const result = await writer.write(
    `Delete category group: ${id}`,
    () => client.api.deleteCategoryGroup(id, transferGroupId)
  );

  if (!result.success) throw new Error(result.error);
}

export async function findCategoryByName(client: ActualClient, name: string): Promise<Category | undefined> {
  const categories = await listCategories(client);
  const lower = name.toLowerCase();
  return categories.find(c => c.name.toLowerCase() === lower)
    || categories.find(c => c.name.toLowerCase().includes(lower));
}

export async function resolveCategoryId(client: ActualClient, nameOrId: string): Promise<string> {
  const categories = await listCategories(client);

  const byId = categories.find(c => c.id === nameOrId);
  if (byId) return byId.id;

  const lower = nameOrId.toLowerCase();
  const byName = categories.find(c => c.name.toLowerCase() === lower);
  if (byName) return byName.id;

  const partial = categories.find(c => c.name.toLowerCase().includes(lower));
  if (partial) return partial.id;

  throw new Error(`Category not found: "${nameOrId}". Available: ${categories.map(c => c.name).join(', ')}`);
}
