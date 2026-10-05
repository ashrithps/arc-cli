/**
 * Category sinking-fund templates.
 *
 * Actual's budget automation lives in the category's note (keyed by the bare
 * category id) as `#template` / `#goal` directives. The arc app's "Savings
 * target" editor writes exactly one sinking-fund template there, plus a
 * companion `#goal` line; this module writes the same pair through the same
 * codec (`src/codecs/category-template.ts`), so either side can edit what the
 * other wrote.
 *
 * A category note is the user's own prose and their hand-written automation.
 * Writes therefore go through `mutateNote`, change only arc's own lines, and
 * refuse whenever the note holds a template arc cannot safely rewrite — the
 * same cases where the app's editor locks itself.
 *
 * Money is integer cents throughout.
 */
import type { ActualClient } from '../client.js';
import type { SafeWriter } from '../safe-writer.js';
import {
  buildGoalLine,
  buildTemplateLine,
  findSinkingTemplateLine,
  hasSinkingSignal,
  hasUnsupportedTemplate,
  isValidSinkingSpec,
  mergeCategoryTemplate,
  parseCategoryNote,
  specFromTemplate,
  type CategoryNoteLine,
  type SinkingFundSpec,
  type TemplateConflict,
} from '../codecs/category-template.js';
import { categoryNoteId, mutateNote, readAllNotes } from './notes.js';
import { validateId } from '../utils/validation.js';

export interface CategoryTemplates {
  categoryId: string;
  categoryName: string;
  groupName: string | null;
  isIncome: boolean;
  /** Every `#template` / `#goal` line in the note, parsed. Prose is omitted. */
  directives: CategoryNoteLine[];
  /** The sinking fund arc can edit, when the note holds one. */
  sinkingFund: SinkingFundSpec | null;
  /** Any sinking signal at all, including a standalone `#goal`. */
  isSinking: boolean;
  /**
   * False when a `#template` here is one arc will not rewrite. Writes are
   * refused until it is edited in Actual, exactly as the app's editor locks.
   */
  editable: boolean;
}

interface CategoryRow {
  id: string;
  name: string;
  groupName: string | null;
  isIncome: boolean;
}

async function listCategoryRows(client: ActualClient): Promise<CategoryRow[]> {
  const groups = await client.api.getCategoryGroups();
  const rows: CategoryRow[] = [];
  for (const group of groups as any[]) {
    for (const cat of group.categories || []) {
      rows.push({
        id: cat.id,
        name: cat.name,
        groupName: group.name ?? null,
        isIncome: !!(cat.is_income ?? group.is_income),
      });
    }
  }
  return rows;
}

function describe(row: CategoryRow, note: string | null): CategoryTemplates {
  const lines = parseCategoryNote(note);
  return {
    categoryId: row.id,
    categoryName: row.name,
    groupName: row.groupName,
    isIncome: row.isIncome,
    directives: lines.filter(l => l.directive !== null),
    sinkingFund: specFromTemplate(findSinkingTemplateLine(lines)?.template ?? null),
    isSinking: hasSinkingSignal(lines),
    editable: !hasUnsupportedTemplate(lines),
  };
}

/** Every category whose note carries at least one `#template` or `#goal` line. */
export async function listTemplates(client: ActualClient): Promise<CategoryTemplates[]> {
  client.ensureConnected();
  const [noteRows, categories] = await Promise.all([
    readAllNotes(client),
    listCategoryRows(client),
  ]);
  const noteById = new Map(noteRows.map(r => [r.id, r.note]));

  return categories
    .map(row => describe(row, noteById.get(categoryNoteId(row.id)) ?? null))
    .filter(t => t.directives.length > 0);
}

async function findCategory(client: ActualClient, categoryId: string): Promise<CategoryRow> {
  validateId(categoryId);
  const row = (await listCategoryRows(client)).find(c => c.id === categoryId);
  if (!row) throw new Error(`Category not found: ${categoryId}`);
  return row;
}

const CONFLICT_MESSAGES: Record<TemplateConflict, string> = {
  'multiple-sinking-templates':
    'holds more than one sinking-fund template, so arc cannot tell which one is its own. Edit it in Actual.',
  'prioritized-template':
    'has a prioritized template (#template-N). Rewriting it would reorder your budget automation. Edit it in Actual.',
};

const UNSUPPORTED_MESSAGE =
  'already has a budget template arc will not rewrite. Edit it in Actual.';

export interface TemplateWriteResult {
  categoryId: string;
  categoryName: string;
  /** The note body as written. */
  note: string;
  /** False when the note already said exactly this. */
  changed: boolean;
}

/**
 * Merge `spec` (or its removal, for null) into a category note, refusing in
 * every case the app's editor refuses. The read and the refusal both happen
 * inside the write, after its sync, so a template the phone added a moment
 * ago is seen rather than overwritten.
 */
async function writeTemplate(
  client: ActualClient,
  writer: SafeWriter,
  row: CategoryRow,
  label: string,
  spec: SinkingFundSpec | null
): Promise<TemplateWriteResult> {
  let changed = false;
  const note = await mutateNote(client, writer, label, categoryNoteId(row.id), current => {
    if (hasUnsupportedTemplate(parseCategoryNote(current))) {
      throw new Error(`Category "${row.name}" ${UNSUPPORTED_MESSAGE}`);
    }
    const merged = mergeCategoryTemplate(current, spec);
    if (merged.conflict) {
      throw new Error(`Category "${row.name}" ${CONFLICT_MESSAGES[merged.conflict]}`);
    }
    changed = merged.changed;
    // The app writes null here, deleting the note row; notes-save takes a string.
    return merged.note ?? '';
  });
  return { categoryId: row.id, categoryName: row.name, note, changed };
}

/**
 * Set (or replace) the category's sinking-fund template.
 *
 * `emitGoal` defaults to true because the app always writes the companion
 * `#goal` line, which makes Actual colour the category on its balance.
 */
export async function setTemplate(
  client: ActualClient,
  writer: SafeWriter,
  categoryId: string,
  fields: {
    targetCents: number;
    /** 'YYYY-MM' */
    byMonth: string;
    /** null or absent = one-shot; 12 is written as "repeat every year". */
    repeatEveryMonths?: number | null;
    emitGoal?: boolean;
  }
): Promise<TemplateWriteResult & { templateLine: string; goalLine: string | null }> {
  client.ensureConnected();
  const spec: SinkingFundSpec = {
    targetCents: fields.targetCents,
    byMonth: fields.byMonth,
    repeatEveryMonths: fields.repeatEveryMonths ?? null,
    emitGoal: fields.emitGoal ?? true,
  };
  if (!isValidSinkingSpec(spec)) {
    throw new Error(
      'Invalid savings target: the amount must be positive, --by must be YYYY-MM, ' +
      'and --repeat-months a whole number of months (1 or more).'
    );
  }

  const row = await findCategory(client, categoryId);
  const result = await writeTemplate(client, writer, row, `Set savings target: ${row.name}`, spec);
  return {
    ...result,
    templateLine: buildTemplateLine(spec),
    goalLine: spec.emitGoal ? buildGoalLine(spec.targetCents) : null,
  };
}

/**
 * Remove arc's sinking-fund template and its companion `#goal` line. Every
 * other line — prose and the user's own directives — is left byte-identical.
 */
export async function clearTemplate(
  client: ActualClient,
  writer: SafeWriter,
  categoryId: string
): Promise<TemplateWriteResult> {
  client.ensureConnected();
  const row = await findCategory(client, categoryId);
  return writeTemplate(client, writer, row, `Remove savings target: ${row.name}`, null);
}
