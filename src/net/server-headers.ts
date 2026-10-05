/**
 * Custom headers for a self-hosted Actual server behind a reverse proxy
 * (Cloudflare Access and the like), configured in the arc app.
 *
 * `@actual-app/api` takes its fetch once, at module load
 * (`var fetch$1 = globalThis.fetch`), and offers no way to pass headers. So the
 * only way in is to wrap `globalThis.fetch` BEFORE that module is first
 * evaluated: `install-server-headers.ts` does it as a side-effect import and is
 * the first import of every entrypoint and of `client.ts`, the one module that
 * imports the api. tests/server-headers.test.ts proves the order.
 *
 * The wrapper adds headers only to requests for the configured server's
 * origin. They are credentials for that proxy; arcreactor and every other host
 * must never see them.
 */
import type { ServerHeader } from '../types.js';

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validate headers from a payload, config file or `ACTUAL_CUSTOM_HEADERS`.
 * An empty list is the same as none. Throws on anything `Headers` would
 * reject later, so a bad value fails at install, not mid-sync.
 */
export function readServerHeaders(value: unknown, where: string): ServerHeader[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error(`Invalid ${where}: must be a list of {name, value}`);
  const headers = value.map((entry, i) => {
    const name = entry?.name, headerValue = entry?.value;
    if (typeof name !== 'string' || !HEADER_NAME.test(name)) {
      throw new Error(`Invalid ${where}[${i}].name: not a valid header name`);
    }
    if (typeof headerValue !== 'string' || /[\r\n\0]/.test(headerValue)) {
      throw new Error(`Invalid ${where}[${i}].value: must be a single-line string`);
    }
    return { name, value: headerValue };
  });
  return headers.length ? headers : undefined;
}

const WRAPPED = Symbol.for('arc.serverHeaderFetch');

let configured: { origin: string; headers: ServerHeader[] } | null = null;

/** Point the wrapper at a server. No headers (or a null origin) turns it off. */
export function setServerHeaders(origin: string | null, headers: ServerHeader[] | undefined): void {
  configured = origin && headers?.length ? { origin: new URL(origin).origin, headers: [...headers] } : null;
}

export function isServerHeaderFetch(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as any)[WRAPPED] === true;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null; // relative or garbage: not our server
  }
}

/** Wrap `globalThis.fetch` once. Safe to call any number of times. */
export function installServerHeaderFetch(): void {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || isServerHeaderFetch(original)) return;

  const wrapped = function arcServerHeaderFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const target = configured;
    if (!target || originOf(requestUrl(input)) !== target.origin) return original(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const { name, value } of target.headers) {
      // The caller's own header wins: Actual's token header, a content-type.
      if (!headers.has(name)) headers.set(name, value);
    }
    return original(input, { ...init, headers });
  } as typeof fetch;
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  globalThis.fetch = wrapped;
}
