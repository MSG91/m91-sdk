/**
 * HTTP on native `fetch`, with the retry policy applied. Zero dependencies.
 *
 * The rules, which are the interesting part:
 *
 * - **429 is retried exactly once**, after exactly the delay the server asked
 *   for. The send limit is 60/minute per link and every 429 carries
 *   `Retry-After: 60`. Retrying a second time would be arguing with it.
 * - **5xx is retried with backoff.** Not the caller's fault, and the alert has
 *   not been raised, so repeating it cannot double-page anybody.
 * - **4xx is never retried.** Not transient; the next identical request fails
 *   identically.
 * - **A network failure is never retried.** A send that timed out may or may not
 *   have raised the alert — the response is what was lost, not necessarily the
 *   request. Blind retries are how one condition wakes a team four times.
 */

import { M91NetworkError, retryAfter, unwrap } from './exceptions.js';

export const USER_AGENT = 'm91-node/1.0.0';

/** Delays before the 2nd, 3rd and 4th attempt at a 5xx. Four requests total. */
export const SERVER_BACKOFF = [1000, 2000, 4000] as const;

export const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

/**
 * A 429 whose `Retry-After` is longer than this is thrown rather than slept
 * through. The server sends 60; anything far past that is a caller sitting
 * blocked in an alerting path, which is worse than an error it can see.
 */
export const MAX_RETRY_AFTER_MS = 120_000;

/**
 * Milliseconds to wait before trying again, or `null` to stop and throw.
 * `attempt` is 1-based and counts requests already made.
 */
export function retryDelay(status: number, attempt: number, retryAfterSeconds?: number): number | null {
  if (status === 429) {
    // Once, and only on the first 429. A second means the window has not
    // actually cleared and the caller needs to hear about it.
    if (attempt >= 2) return null;
    const wait = (retryAfterSeconds ?? 60) * 1000;
    return wait > MAX_RETRY_AFTER_MS ? null : Math.max(wait, 0);
  }
  if (RETRYABLE_STATUSES.has(status)) {
    return attempt > SERVER_BACKOFF.length ? null : SERVER_BACKOFF[attempt - 1];
  }
  return null;
}

/**
 * Matches a send link anywhere — in a bare URL, or buried in a sentence — and
 * takes any query string attached to it. Bounded on whitespace so it stops at
 * the end of the URL rather than eating the rest of the message.
 */
const SEND_URL_RE = /(\/s\/)[^\s/?#]+(\?[^\s]*)?/g;

/**
 * Replace a send link's token with `***`, wherever it appears.
 *
 * **The token is the credential and it lives in the path**, so a URL is as
 * sensitive as a password and must never reach a log, an error message or a
 * stack trace intact. The server holds itself to the same rule — its error
 * handler reports the route *pattern*, never `req.path`.
 *
 * This takes free text, not only a URL, and that is the point. Redacting only
 * the URL the SDK interpolates is not enough: a fetch failure can carry the URL
 * in its own message, so a carefully-redacted sentence would arrive with the
 * raw token attached to it by the runtime.
 *
 * Query strings go too: a GET-form send carries the alert title, and titles
 * routinely name customers and hosts.
 */
export function redact(text: string): string {
  if (typeof text !== 'string') return text;
  return text.replace(SEND_URL_RE, '$1***');
}

export interface RequestOptions {
  method: string;
  url: string;
  body?: unknown;
  query?: Record<string, string>;
}

export interface TransportOptions {
  /** Whole-request budget in milliseconds. Default 15s (5s connect + 10s read). */
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Swappable so tests need no network and no mocking library. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Transport {
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: TransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.headers = {
      // A GET-form send answers with a rendered HTML page when the caller looks
      // like a browser. That page exists so a person tapping a bookmark sees
      // something other than a wall of JSON — but an SDK is not a person, and
      // has to opt out of it explicitly.
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...options.headers,
    };
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  async request({ method, url, body, query }: RequestOptions): Promise<unknown> {
    const target = query ? `${url}?${new URLSearchParams(query).toString()}` : url;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      let status: number;
      let headers: Headers;
      let parsed: unknown;
      try {
        const response = await this.fetchImpl(target, {
          method,
          headers: body === undefined
            ? this.headers
            : { ...this.headers, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        status = response.status;
        headers = response.headers;
        parsed = await readBody(response);
      } catch (error) {
        // Redacted AFTER composing, not before: a fetch failure can name the
        // URL in its own message, so masking only our half still ships the token.
        const reason = error instanceof Error ? error.message : String(error);
        throw new M91NetworkError(redact(`Could not reach M91 at ${target}: ${reason}`));
      } finally {
        clearTimeout(timer);
      }

      const delay = retryDelay(status, attempt, retryAfter(headers));
      if (delay === null) return unwrap(status, parsed, headers);
      await this.sleepImpl(delay);
    }
  }
}

/**
 * The parsed envelope, or something `unwrap` can still turn into an error.
 *
 * A non-JSON body here means a proxy, a load balancer or an HTML error page
 * answered instead of M91. Wrapping the text in an envelope-shaped object keeps
 * all the error construction in one place rather than adding a second path.
 */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return { error: { message: `HTTP ${response.status} with an empty body` } };
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 300) } };
  }
}
