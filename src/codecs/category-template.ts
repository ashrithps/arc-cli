/**
 * Category sinking-fund templates — ported verbatim from the arc app's
 * `utils/categoryTemplate.ts`. Below this header the code is the app's, byte
 * for byte; keep it that way. The app and the CLI write the same category
 * notes, and those notes sync to the user's real Actual server, so any
 * divergence here is a data-integrity bug on their budget.
 *
 * Actual keeps budget automation in the `notes` table under the raw category
 * uuid, one directive per line:
 *
 *   #template 500 by 2026-12 repeat every year
 *   #template 300 repeat every 3 months starting 2026-01-01
 *   #goal 500
 *
 * Applying a template writes `goal` / `long_goal` onto the `zero_budgets` row.
 * `long_goal` means "judge this category on its balance, not on this month's
 * budgeted amount" — which is exactly a sinking fund.
 *
 * The contract here is **parse wide, write narrow, never drop a line**. Every
 * documented form parses; anything we cannot model still yields a line with its
 * `raw` intact so the serializer round-trips it byte-for-byte. We only ever
 * *write* the two forms that express a sinking fund, plus the `#goal` directive.
 *
 * Everything below errs toward refusing. Amounts are integer cents. Pure
 * module — no client, no IO.
 */

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export type RepeatUnit = 'day' | 'week' | 'month' | 'year';

export interface RepeatSpec {
  every: number;
  unit: RepeatUnit;
}

export interface LimitSpec {
  amountCents: number;
  period: 'monthly' | 'weekly' | 'daily';
  hold: boolean;
}

export type ParsedTemplate =
  | { kind: 'by'; amountCents: number; byMonth: string; repeat: RepeatSpec | null; spendFrom: string | null }
  | { kind: 'periodic'; amountCents: number; repeat: RepeatSpec; startDate: string | null; limit: LimitSpec | null }
  | { kind: 'simple'; amountCents: number | null; limit: LimitSpec | null }
  | { kind: 'percentage'; percent: number; basis: string }
  | { kind: 'schedule'; scheduleName: string; full: boolean }
  | { kind: 'remainder'; weight: number; limit: LimitSpec | null }
  | { kind: 'average'; months: number }
  | { kind: 'copy'; monthsAgo: number }
  | { kind: 'goal'; amountCents: number }
  | { kind: 'unknown' };

export interface CategoryNoteLine {
  /** Verbatim, untrimmed — required for lossless rewrite. */
  raw: string;
  index: number;
  directive: 'template' | 'goal' | null;
  /** From `#template-N`; null when unprioritised. */
  priority: number | null;
  template: ParsedTemplate | null;
}

/** The subset arc is willing to author. */
export interface SinkingFundSpec {
  targetCents: number;
  /** 'YYYY-MM' */
  byMonth: string;
  /** null = one-shot. 12 is emitted as "repeat every year". */
  repeatEveryMonths: number | null;
  /** Also write a companion `#goal N` line. */
  emitGoal: boolean;
}

export type TemplateConflict = 'multiple-sinking-templates' | 'prioritized-template';

export interface MergeResult {
  note: string | null;
  changed: boolean;
  conflict: TemplateConflict | null;
}

// ────────────────────────────────────────────────────────────────────
// Grammar
// ────────────────────────────────────────────────────────────────────

/*
 * `#goal` MUST be anchored with (?=\s|$), never \b.
 *
 * arc has its own, unrelated savings-*account* tag with the shape `#goal:Name|...`
 * (see src/codecs/goal-tag.ts). A \b boundary sits between the `l`
 * and the `:`, so `\b` would match arc's tag and misread it as an Actual goal
 * directive. The lookahead requires whitespace or end-of-line, which `:` is not.
 */
const DIRECTIVE_RE = /^\s*#(template|goal)(?:-(\d+))?(?=\s|$)\s*(.*)$/i;

const AMOUNT_SRC = String.raw`-?\$?\s*[\d,]+(?:\.\d+)?`;

const UP_TO_RE = new RegExp(
  String.raw`\bup\s+to\s+(${AMOUNT_SRC})(?:\s+per\s+(week|day))?(\s+hold)?\s*$`,
  'i',
);
const SCHEDULE_RE = /^schedule\s+(?:(full)\s+)?(.+?)\s*$/i;
const REMAINDER_RE = /^remainder(?:\s+(\d+(?:\.\d+)?))?\s*$/i;
const AVERAGE_RE = /^average\s+(\d+)\s+months?\b/i;
const COPY_RE = /^copy\s+from\s+(\d+)\s+months?\s+ago\s*$/i;
const PERCENT_RE = /^(\d+(?:\.\d+)?)\s*%\s+of\s+(.+?)\s*$/i;
const BY_RE = new RegExp(String.raw`^(${AMOUNT_SRC})\s+by\s+(\d{4}-\d{2})(?:-\d{2})?\b`, 'i');
const PERIODIC_HEAD_RE = new RegExp(String.raw`^(${AMOUNT_SRC})\s+repeat\s`, 'i');
const REPEAT_RE = /\brepeat\s+every\s+(?:(\d+)\s+)?(month|months|year|years|week|weeks|day|days)\b/i;
const STARTING_RE = /\bstarting\s+(\d{4}-\d{2}-\d{2})\b/i;
const SPEND_FROM_RE = /\bspend\s+from\s+(\d{4}-\d{2})(?:-\d{2})?\b/i;
const BARE_AMOUNT_RE = new RegExp(String.raw`^(${AMOUNT_SRC})\s*$`, 'i');

/** Lenient on read: tolerates `$`, thousands separators and stray spaces. */
function parseAmountCents(raw: string): number | null {
  const cleaned = raw.replace(/[$\s,]/g, '');
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function normaliseUnit(word: string): RepeatUnit {
  const w = word.toLowerCase();
  if (w.startsWith('year')) return 'year';
  if (w.startsWith('week')) return 'week';
  if (w.startsWith('day')) return 'day';
  return 'month';
}

function parseRepeat(body: string): RepeatSpec | null {
  const m = REPEAT_RE.exec(body);
  if (!m) return null;
  const every = m[1] ? parseInt(m[1], 10) : 1;
  if (!Number.isFinite(every) || every < 1) return null;
  return { every, unit: normaliseUnit(m[2]) };
}

function peelLimit(body: string): { rest: string; limit: LimitSpec | null } {
  const m = UP_TO_RE.exec(body);
  if (!m) return { rest: body, limit: null };
  const amountCents = parseAmountCents(m[1]);
  if (amountCents === null) return { rest: body, limit: null };
  const period = m[2] ? (m[2].toLowerCase() === 'week' ? 'weekly' : 'daily') : 'monthly';
  return {
    rest: body.slice(0, m.index).trimEnd(),
    limit: { amountCents, period, hold: Boolean(m[3]) },
  };
}

function parseTemplateBody(body: string): ParsedTemplate {
  const trimmed = body.trim();
  if (!trimmed) return { kind: 'unknown' };

  const scheduleMatch = SCHEDULE_RE.exec(trimmed);
  if (scheduleMatch) {
    return { kind: 'schedule', scheduleName: scheduleMatch[2].trim(), full: Boolean(scheduleMatch[1]) };
  }

  const copyMatch = COPY_RE.exec(trimmed);
  if (copyMatch) return { kind: 'copy', monthsAgo: parseInt(copyMatch[1], 10) };

  const averageMatch = AVERAGE_RE.exec(trimmed);
  if (averageMatch) return { kind: 'average', months: parseInt(averageMatch[1], 10) };

  const percentMatch = PERCENT_RE.exec(trimmed);
  if (percentMatch) {
    return { kind: 'percentage', percent: Number(percentMatch[1]), basis: percentMatch[2].trim() };
  }

  // `by` never takes an `up to`, so match it before peeling the limit suffix.
  const byMatch = BY_RE.exec(trimmed);
  if (byMatch) {
    const amountCents = parseAmountCents(byMatch[1]);
    if (amountCents === null) return { kind: 'unknown' };
    const spendFrom = SPEND_FROM_RE.exec(trimmed);
    return {
      kind: 'by',
      amountCents,
      byMonth: byMatch[2],
      repeat: parseRepeat(trimmed),
      spendFrom: spendFrom ? spendFrom[1] : null,
    };
  }

  const { rest, limit } = peelLimit(trimmed);

  const remainderMatch = REMAINDER_RE.exec(rest);
  if (remainderMatch) {
    return { kind: 'remainder', weight: remainderMatch[1] ? Number(remainderMatch[1]) : 1, limit };
  }

  if (PERIODIC_HEAD_RE.test(rest)) {
    const amountCents = parseAmountCents(PERIODIC_HEAD_RE.exec(rest)![1]);
    const repeat = parseRepeat(rest);
    if (amountCents === null || !repeat) return { kind: 'unknown' };
    const starting = STARTING_RE.exec(rest);
    return { kind: 'periodic', amountCents, repeat, startDate: starting ? starting[1] : null, limit };
  }

  const bare = BARE_AMOUNT_RE.exec(rest);
  if (bare) {
    const amountCents = parseAmountCents(bare[1]);
    if (amountCents === null) return { kind: 'unknown' };
    return { kind: 'simple', amountCents, limit };
  }

  // `#template up to 150` — the whole body was the limit.
  if (!rest && limit) return { kind: 'simple', amountCents: null, limit };

  return { kind: 'unknown' };
}

// ────────────────────────────────────────────────────────────────────
// Parsing
// ────────────────────────────────────────────────────────────────────

export function parseCategoryNote(note: string | null | undefined): CategoryNoteLine[] {
  if (!note) return [];
  return note.split(/\r?\n/).map((raw, index) => {
    const m = DIRECTIVE_RE.exec(raw);
    if (!m) return { raw, index, directive: null, priority: null, template: null };

    const directive = m[1].toLowerCase() === 'goal' ? ('goal' as const) : ('template' as const);
    const priority = m[2] ? parseInt(m[2], 10) : null;
    const body = m[3] ?? '';

    if (directive === 'goal') {
      const amountCents = parseAmountCents(body.trim());
      return {
        raw,
        index,
        directive,
        priority,
        template: amountCents === null ? { kind: 'unknown' as const } : { kind: 'goal' as const, amountCents },
      };
    }

    return { raw, index, directive, priority, template: parseTemplateBody(body) };
  });
}

/**
 * Does this template express money held for a future month rather than a
 * monthly spending pace?
 *
 * `repeat every month|week|day` is deliberately excluded — that is a pacing
 * template, not a sinking fund.
 */
export function isSinkingTemplate(template: ParsedTemplate | null): boolean {
  if (!template) return false;
  if (template.kind === 'by' || template.kind === 'goal') return true;
  if (template.kind === 'periodic') {
    if (template.repeat.unit === 'year') return true;
    return template.repeat.unit === 'month' && template.repeat.every > 1;
  }
  return false;
}

/** The template line arc considers its own: the first `by` / multi-month `periodic`. */
export function findSinkingTemplateLine(lines: CategoryNoteLine[]): CategoryNoteLine | null {
  return lines.find(
    (l) =>
      l.directive === 'template' &&
      l.template !== null &&
      (l.template.kind === 'by' || (l.template.kind === 'periodic' && isSinkingTemplate(l.template))),
  ) ?? null;
}

/** Any sinking signal at all, including a standalone `#goal`. */
export function hasSinkingSignal(lines: CategoryNoteLine[]): boolean {
  return lines.some((l) => l.directive !== null && isSinkingTemplate(l.template));
}

/** A `#template` line arc parsed but cannot model — the editor must stay read-only. */
export function hasUnsupportedTemplate(lines: CategoryNoteLine[]): boolean {
  return lines.some(
    (l) =>
      l.directive === 'template' &&
      (l.template === null || l.template.kind === 'unknown' || !isSinkingTemplate(l.template)),
  );
}

// ────────────────────────────────────────────────────────────────────
// Serialising
// ────────────────────────────────────────────────────────────────────

/**
 * Actual's parser is stricter than its docs: no currency symbol, no thousands
 * separator, ASCII only, `.` as the decimal mark.
 */
export function formatTemplateAmount(cents: number): string {
  const fixed = (cents / 100).toFixed(2);
  return fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed;
}

export function buildTemplateLine(spec: SinkingFundSpec): string {
  const parts = ['#template', formatTemplateAmount(spec.targetCents), 'by', spec.byMonth];
  if (spec.repeatEveryMonths !== null) {
    parts.push(
      'repeat',
      'every',
      ...(spec.repeatEveryMonths === 12 ? ['year'] : [String(spec.repeatEveryMonths), 'months']),
    );
  }
  return parts.join(' ');
}

export function buildGoalLine(cents: number): string {
  return `#goal ${formatTemplateAmount(cents)}`;
}

/** Reverse of buildTemplateLine: seed the editor from what is already there. */
export function specFromTemplate(template: ParsedTemplate | null): SinkingFundSpec | null {
  if (!template) return null;
  if (template.kind === 'by') {
    const repeat = template.repeat;
    const every =
      repeat === null ? null
      : repeat.unit === 'year' ? repeat.every * 12
      : repeat.unit === 'month' ? repeat.every
      : null;
    return {
      targetCents: template.amountCents,
      byMonth: template.byMonth,
      repeatEveryMonths: every,
      emitGoal: true,
    };
  }
  return null;
}

export function isValidSinkingSpec(spec: SinkingFundSpec): boolean {
  if (!Number.isInteger(spec.targetCents) || spec.targetCents <= 0) return false;
  if (!/^\d{4}-\d{2}$/.test(spec.byMonth)) return false;
  const month = parseInt(spec.byMonth.slice(5), 10);
  if (month < 1 || month > 12) return false;
  if (spec.repeatEveryMonths !== null) {
    if (!Number.isInteger(spec.repeatEveryMonths) || spec.repeatEveryMonths < 1) return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────
// Merging
// ────────────────────────────────────────────────────────────────────

/**
 * Rewrite arc's own template line, leaving every other line byte-identical.
 *
 * Deliberately gentler than mergeDebtTag (src/codecs/debt-tag.ts), which trims every line
 * and drops empty ones. That is safe for account notes, which arc effectively
 * owns. A *category* note is the user's free-text prose, and collapsing their
 * blank lines and indentation would be silent data loss on a synced record.
 *
 * arc owns exactly one `#template` line (the first `by` / multi-month
 * `periodic`) and, when it wrote one, the `#goal` line directly beneath it.
 * Anything else is refused rather than guessed at.
 */
export function mergeCategoryTemplate(
  existingNote: string | null | undefined,
  spec: SinkingFundSpec | null,
): MergeResult {
  const original = existingNote ?? '';
  const lines = parseCategoryNote(original);

  const sinkingLines = lines.filter(
    (l) =>
      l.directive === 'template' &&
      l.template !== null &&
      (l.template.kind === 'by' || (l.template.kind === 'periodic' && isSinkingTemplate(l.template))),
  );

  if (sinkingLines.length > 1) {
    return { note: original || null, changed: false, conflict: 'multiple-sinking-templates' };
  }
  const owned = sinkingLines[0] ?? null;
  if (owned && owned.priority !== null) {
    // Priority bands change Actual's apply order; rewriting one would silently
    // reshuffle the user's automation.
    return { note: original || null, changed: false, conflict: 'prioritized-template' };
  }
  if (spec && !isValidSinkingSpec(spec)) {
    return { note: original || null, changed: false, conflict: null };
  }

  const eol = /\r\n/.test(original) ? '\r\n' : '\n';
  const endsWithNewline = /\r?\n$/.test(original);
  const out = original === '' ? [] : original.split(/\r?\n/);
  // A trailing newline yields a phantom empty final element; drop it and
  // re-add the terminator at the end so the note's shape survives.
  if (endsWithNewline) out.pop();

  // The `#goal` line arc owns is the one immediately after its template line.
  const ownedGoalIndex =
    owned !== null && lines[owned.index + 1]?.directive === 'goal' ? owned.index + 1 : -1;

  if (spec === null) {
    if (owned === null) {
      return { note: original || null, changed: false, conflict: null };
    }
    const drop = new Set<number>([owned.index]);
    if (ownedGoalIndex >= 0) drop.add(ownedGoalIndex);
    const kept = out.filter((_, i) => !drop.has(i));
    const merged = kept.join(eol) + (endsWithNewline && kept.length > 0 ? eol : '');
    const note = merged.trim().length > 0 ? merged : null;
    return { note, changed: note !== (original || null), conflict: null };
  }

  const templateLine = buildTemplateLine(spec);
  const goalLine = spec.emitGoal ? buildGoalLine(spec.targetCents) : null;

  if (owned !== null) {
    out[owned.index] = templateLine;
    if (ownedGoalIndex >= 0) {
      if (goalLine) out[ownedGoalIndex] = goalLine;
      else out.splice(ownedGoalIndex, 1);
    } else if (goalLine) {
      out.splice(owned.index + 1, 0, goalLine);
    }
  } else {
    // Group with the existing directives when there are any, so the note keeps
    // the shape Actual's own UI produces; otherwise append below the prose.
    let lastDirective = -1;
    for (const l of lines) if (l.directive !== null) lastDirective = l.index;
    const insertAt = lastDirective >= 0 ? lastDirective + 1 : out.length;
    out.splice(insertAt, 0, ...(goalLine ? [templateLine, goalLine] : [templateLine]));
  }

  const merged = out.join(eol) + (endsWithNewline ? eol : '');
  return { note: merged, changed: merged !== original, conflict: null };
}
