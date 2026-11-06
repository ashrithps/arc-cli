/**
 * The one thing a name or id refers to, or an error. Never a guess.
 *
 * Every command resolves accounts, categories, category groups and payees
 * by id, else exact name (any case), else part of the name. Each step that
 * finds more than one is refused with the candidates' ids; it never takes the
 * first, and never falls through to a looser step to find a single one. A
 * write on the wrong one of two same-named things (undo a statement, close or
 * delete an account, delete a category, merge payees) would do the most harm
 * and say nothing (found 2026-11-07 with `statements undo` on two cards of
 * one name).
 */
export class AmbiguousRefError extends Error {
  constructor(kind: string, ref: string, matches: string[]) {
    super(`"${ref}" matches ${matches.length} ${kind.endsWith('y') ? `${kind.slice(0, -1)}ies` : `${kind}s`}: ${matches.join('; ')}. Pass the ${kind}'s id instead of its name.`);
    this.name = 'AmbiguousRefError';
  }
}

export function pickOne<T extends { id: string }>(
  items: readonly T[],
  ref: string,
  opts: {
    kind: string;
    nameOf: (item: T) => string;
    /** How a candidate is listed in the error: name and id, plus anything that tells them apart. */
    describe?: (item: T) => string;
    /** Try a part of the name when no exact name matches (default true). */
    partial?: boolean;
    notFound: () => Error;
    /** The error for several matches; default AmbiguousRefError. */
    ambiguous?: (matches: T[]) => Error;
  },
): T {
  const byId = items.find((i) => i.id === ref);
  if (byId) return byId;
  const describe = opts.describe ?? ((i: T) => `${opts.nameOf(i)} (id ${i.id})`);
  const ambiguous = opts.ambiguous ?? ((m: T[]) => new AmbiguousRefError(opts.kind, ref, m.map(describe)));
  const lower = ref.toLowerCase();
  const exact = items.filter((i) => (opts.nameOf(i) ?? '').toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw ambiguous(exact);
  if (opts.partial !== false) {
    const partial = items.filter((i) => (opts.nameOf(i) ?? '').toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw ambiguous(partial);
  }
  throw opts.notFound();
}
