/**
 * Every failure the SDK can throw, and the one place an HTTP response becomes one.
 *
 * Branch on `.code` — a stable string the API contract pins down — never on
 * `.message`, which is written for a person reading a terminal and is expected
 * to change.
 */

export class M91Error extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly details?: unknown;

  constructor(message: string, code = 'M91_ERROR', statusCode?: number, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    // Without this, `err instanceof M91ValidationError` is false when the
    // package is compiled down to ES5 by a consumer's bundler.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 400/413. The request was wrong, and it is never retried.
 *
 * Also thrown locally, before any HTTP call, when a field breaks a documented
 * limit. Every schema server-side is `.strict()`, so a mistyped field name is a
 * 400 rather than a silent drop — and a round trip to learn that is a round
 * trip wasted.
 */
export class M91ValidationError extends M91Error {
  constructor(message: string, details?: unknown, statusCode = 400, code = 'VALIDATION_ERROR') {
    super(message, code, statusCode, details);
  }
}

/** 401. Credential invalid, expired or revoked — nothing is cached server-side. */
export class M91AuthError extends M91Error {
  constructor(message = 'Unauthorized', details?: unknown) {
    super(message, 'UNAUTHORIZED', 401, details);
  }
}

/** 403. Authenticated, but not allowed. On `close()` this means success. */
export class M91ForbiddenError extends M91Error {
  constructor(message = 'Forbidden', details?: unknown) {
    super(message, 'FORBIDDEN', 403, details);
  }
}

/**
 * 404. Absent — **or present and not yours**. The API answers the same way to
 * both on purpose, so an id cannot become an oracle for what exists.
 */
export class M91NotFoundError extends M91Error {
  constructor(message = 'Not found', details?: unknown) {
    super(message, 'NOT_FOUND', 404, details);
  }
}

/**
 * 409. The channel has nobody who can actually be woken.
 *
 * `unregistered` is the invited numbers with no M91 account — invited, never
 * installed the app, and unreachable. An ordinary SMS would not pierce Do Not
 * Disturb, would not repeat, and would not escalate.
 */
export class M91ChannelEmptyError extends M91Error {
  readonly unregistered: string[];

  constructor(message: string, unregistered: string[] = [], details?: unknown) {
    super(message, 'CHANNEL_EMPTY', 409, details);
    this.unregistered = unregistered;
  }
}

/**
 * 429. 60 sends a minute per send link.
 *
 * `retryAfter` always has a value: the server sets `Retry-After` on every 429
 * precisely so a caller does not have to guess, and the usual guess is to retry
 * immediately and forever.
 */
export class M91RateLimitError extends M91Error {
  readonly retryAfter: number;

  constructor(message = 'Rate limited', retryAfter = 60, details?: unknown) {
    super(message, 'RATE_LIMITED', 429, details);
    this.retryAfter = retryAfter;
  }
}

/** 5xx. Not the caller's fault. Retried with backoff before it reaches you. */
export class M91ServerError extends M91Error {
  constructor(message = 'Internal server error', statusCode = 500, details?: unknown) {
    super(message, 'INTERNAL_ERROR', statusCode, details);
  }
}

/**
 * The request never got an answer — DNS, TLS, connect or read timeout.
 *
 * Not retried. A send that timed out may or may not have raised an alert, and
 * retrying it blindly is how one condition wakes a team four times.
 */
export class M91NetworkError extends M91Error {
  constructor(message = 'Network error', details?: unknown) {
    super(message, 'NETWORK_ERROR', undefined, details);
  }
}

/**
 * The API said 2xx and **nobody's phone rang**.
 *
 * The failure mode integrations actually hit, and it is invisible if you only
 * check the status code. `delivered` counts phones sent to, not the size of the
 * roster: a channel of four whose device tokens are all stale answers 201 with
 * `delivered: 0`.
 *
 * A *deduplicated* send is not this error — `delivered` is 0 because the same
 * alert is already open and already ringing, which is success.
 */
export class M91DeliveryError extends M91Error {
  readonly delivered: number;
  readonly unregistered: string[];
  readonly noDevice: number;
  readonly pending: number;

  constructor(
    message: string,
    delivered = 0,
    unregistered: string[] = [],
    noDevice = 0,
    pending = 0,
  ) {
    super(message, 'DELIVERY_FAILED');
    this.delivered = delivered;
    this.unregistered = unregistered;
    this.noDevice = noDevice;
    this.pending = pending;
  }
}

/** `waitForDecision` ran out of time with no SHARED response. Nobody answered. */
export class M91TimeoutError extends M91Error {
  readonly customId: string;
  readonly timeoutMs: number;

  constructor(customId: string, timeoutMs: number) {
    super(
      `Nobody answered '${customId}' within ${Math.round(timeoutMs / 1000)}s. The alert is still open.`,
      'TIMEOUT',
    );
    this.customId = customId;
    this.timeoutMs = timeoutMs;
  }
}

interface ErrorEnvelope {
  success?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
}

/**
 * Turn one HTTP response into either the payload or a thrown error.
 *
 * **Every M91 route answers in an envelope** — `{ success: true, data }` or
 * `{ success: false, error: { code, message, details } }` — and this is the only
 * place the SDK knows that. Everything above this line sees the inner `data`.
 *
 * The error class is chosen by HTTP status rather than by `error.code`, because
 * the status is what the server derives the code from in the first place;
 * keeping them in step in two places is how they drift apart. The body's `code`
 * is still carried onto the error.
 */
export function unwrap(status: number, body: unknown, headers?: Headers | Record<string, string>): unknown {
  const envelope = (body ?? {}) as ErrorEnvelope;
  const err = envelope.error ?? {};
  const details = err.details;
  const code = err.code;

  if (status >= 200 && status < 300) {
    if (envelope && typeof envelope === 'object' && 'data' in envelope) return envelope.data;
    // A route outside the envelope, or a proxy that rewrote the body. Hand it
    // back rather than inventing a failure the server never reported.
    return body;
  }

  const message = err.message || `M91 request failed with HTTP ${status}`;

  if (status === 409 || code === 'CHANNEL_EMPTY') {
    const unregistered = (details as { unregistered?: string[] } | undefined)?.unregistered ?? [];
    throw new M91ChannelEmptyError(message, unregistered, details);
  }
  if (status === 429) throw new M91RateLimitError(message, retryAfter(headers) ?? 60, details);
  if (status === 400) throw withCode(new M91ValidationError(message, details), code);
  if (status === 413) {
    throw new M91ValidationError(message, details, 413, code || 'PAYLOAD_TOO_LARGE');
  }
  if (status === 401) throw withCode(new M91AuthError(message, details), code);
  if (status === 403) throw withCode(new M91ForbiddenError(message, details), code);
  if (status === 404) throw withCode(new M91NotFoundError(message, details), code);
  if (status >= 500) throw new M91ServerError(message, status, details);

  throw new M91Error(message, code || 'M91_ERROR', status, details);
}

function withCode<T extends M91Error>(error: T, code?: string): T {
  if (code) (error as { code: string }).code = code;
  return error;
}

/** Seconds from `Retry-After`, or undefined. Header lookups are case-insensitive. */
export function retryAfter(headers?: Headers | Record<string, string>): number | undefined {
  if (!headers) return undefined;
  const raw =
    typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get('retry-after')
      : Object.entries(headers as Record<string, string>).find(
          ([k]) => k.toLowerCase() === 'retry-after',
        )?.[1];
  if (raw === null || raw === undefined) return undefined;
  const seconds = Number(String(raw).trim());
  return Number.isFinite(seconds) ? Math.max(0, Math.trunc(seconds)) : undefined;
}
