import { createHash } from 'crypto';

export function makeImportedId(parts: Array<string | number | boolean | null | undefined>): string {
  const normalized = parts
    .map(part => (part == null ? '' : String(part).trim()))
    .join('|');

  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 16);
  return `arctual:${hash}`;
}
