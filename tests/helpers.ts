/**
 * Shared fakes. **No test here touches the network.**
 *
 * The transport is exercised for real — envelope unwrapping, error mapping and
 * the retry loop all run — by swapping `fetch` underneath it rather than
 * stubbing the SDK method above it. Mocking at the method level would test that
 * the stub returns what it was told to.
 */

export const SEND_LINK = 'https://m91-api.msg91.com/s/tok_test123';
export const API_KEY = 'm91sk_test_abcdef';
export const PHONE = '919876543210';

export interface Recorded {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A success envelope, exactly as `utils/response.js` writes one. */
export function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** An error envelope. */
export function err(
  code: string,
  message = 'nope',
  status = 400,
  details?: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message, details } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * A send response. Note what is **absent**: the server omits `deduplicated`,
 * `noDevice`, `pending`, `reopened` and `message` rather than sending them
 * false or zero.
 */
export function alertPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: '68c0a1f2e4b09c3d5f8a0001',
    channelId: '68c0a1f2e4b09c3d5f8a0002',
    channelName: 'Payments on-call',
    customId: null,
    severity: 'MEDIUM',
    status: 'OPEN',
    isAutoClose: false,
    responseOptions: [],
    createdAt: '2026-09-21T10:00:00.000Z',
    delivered: 4,
    unregistered: [],
    ...overrides,
  };
}

export function detailPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: '68c0a1f2e4b09c3d5f8a0001',
    customId: 'deploy-approval',
    status: 'OPEN',
    severity: 'HIGH',
    title: 'Approve deploy to prod?',
    createdAt: '2026-09-21T10:00:00.000Z',
    isAutoClose: false,
    reopenCount: 0,
    responseOptions: [
      { label: 'Approve', effect: 'SHARED' },
      { label: 'Reject', effect: 'SHARED' },
    ],
    responses: [],
    decision: null,
    resolvedAt: null,
    ...overrides,
  };
}

/** Queues responses and records the requests that consumed them. */
export class Recorder {
  queue: Response[] = [];
  calls: Recorded[] = [];
  slept: number[] = [];

  push(...responses: Response[]): this {
    this.queue.push(...responses);
    return this;
  }

  get last(): Recorded {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error('no requests were made');
    return call;
  }

  /** The parsed JSON body of the nth request (0-based). */
  bodyOf(index: number): Record<string, unknown> {
    return (this.calls[index]?.body ?? {}) as Record<string, unknown>;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const raw = init?.body;
    this.calls.push({
      method: init?.method ?? 'GET',
      url,
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        `unexpected ${init?.method ?? 'GET'} ${url} — no response queued ` +
          `(already made ${this.calls.length - 1})`,
      );
    }
    return next;
  };

  /** Instant, and records what would have been waited. */
  readonly sleep = async (ms: number): Promise<void> => {
    this.slept.push(ms);
  };

  get options() {
    return { fetchImpl: this.fetch, sleepImpl: this.sleep };
  }
}

/** A fetch that always fails to connect, for the network-error cases. */
export function unreachableFetch(recorder: Recorder): typeof fetch {
  return async (input, init) => {
    recorder.calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: undefined,
      headers: {},
    });
    throw new TypeError('fetch failed');
  };
}
