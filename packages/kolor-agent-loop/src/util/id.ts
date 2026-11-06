import { createHash, randomUUID } from 'node:crypto';

/** A short, collision-resistant id with a readable prefix. */
export function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Stable 8 character hash used to disambiguate truncated tool names. */
export function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}
