/**
 * The send-link client: raise an alert, read what was decided, close it.
 *
 * A send link is a credential in a URL. It goes in a Grafana webhook field, a
 * cron, a CI job or an agent's environment, and it needs no header, no account
 * and no library — which is why this client is a convenience over one URL
 * rather than the only way in.
 *
 * Two things it does that a bare `fetch` does not, and both are why it exists:
 *
 * - **It checks that somebody was actually reached.** A 201 means the alert was
 *   filed, not that a phone rang.
 * - **It reads the decision, not the responses.** Only a SHARED response decides.
 */

import {
  M91DeliveryError,
  M91ForbiddenError,
  M91NotFoundError,
  M91TimeoutError,
  M91ValidationError,
} from './exceptions.js';
import { Transport, type TransportOptions, redact } from './http.js';
import {
  type AlertDetail,
  type AlertResponse,
  type ChannelInfo,
  type Decision,
  type ResponseOption,
  type Severity,
  buildAlertPayload,
  isApproved,
  parseAlertDetail,
  parseAlertResponse,
  parseChannelInfo,
} from './models.js';
import { normalizeSendLink } from './url-builder.js';

/**
 * Below this, polling is a busy loop against a rate-limited endpoint and buys
 * nothing: a human waking up and reaching for a phone is not a sub-second event.
 */
export const MIN_POLL_INTERVAL_MS = 2000;

export interface SendOptions {
  description?: string;
  /**
   * LOW and MEDIUM deliver at alarm volume through Do Not Disturb. **HIGH and
   * CRITICAL also place a voice call** if nobody answers in 45 seconds, so they
   * are never the default — "I didn't specify" must not mean "ring everyone".
   */
  severity?: Severity;
  /**
   * Your own stable id for *the condition*, not for this occurrence. The same
   * disk filling up is the same `customId` every time. Built from a timestamp
   * or a UUID it defeats deduplication — a check running every minute raises
   * sixty alerts an hour — and leaves nothing stable to close by.
   */
  customId?: string;
  /**
   * Left false, the alert stays open until somebody closes it, even after a
   * SHARED response claims it. Set true when the first person taking it on is
   * genuinely the end of the matter.
   */
  isAutoClose?: boolean;
  responseOptions?: Array<ResponseOption | string>;
}

export interface WaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  throwOnTimeout?: boolean;
}

export interface ApprovalOptions {
  customId: string;
  description?: string;
  severity?: Severity;
  approveLabel?: string;
  rejectLabel?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** A timeout returns false. There is deliberately no option making it true. */
  timeoutMeansReject?: boolean;
}

export interface ClientOptions extends TransportOptions {
  /**
   * Throw `M91DeliveryError` when a send reaches nobody. On by default, because
   * the silent version of this failure is an alert nobody ever hears about.
   */
  throwOnZeroDelivery?: boolean;
}

/** Alerts one channel, through one send link. */
export class M91Client {
  readonly sendLink: string;
  readonly throwOnZeroDelivery: boolean;
  private readonly http: Transport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(sendLink: string, options: ClientOptions = {}) {
    this.sendLink = normalizeSendLink(sendLink);
    this.throwOnZeroDelivery = options.throwOnZeroDelivery !== false;
    this.http = new Transport(options);
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = () => Date.now();
  }

  /** Redacted, always: a token in a log, a trace or a crash report can wake a team. */
  toString(): string {
    return `M91Client(${redact(this.sendLink)})`;
  }

  private url(suffix = ''): string {
    return this.sendLink + suffix;
  }

  /**
   * Check the link works, and see which channel it points at.
   *
   * **Raises no alert.** Safe on startup, in a health check, or while somebody
   * is pasting the URL into a settings page — which is the point: a mistyped
   * link otherwise shows "connected" and only reveals itself days later, when
   * an alert silently fails to fire.
   */
  async verify(): Promise<ChannelInfo> {
    return parseChannelInfo(await this.http.request({ method: 'GET', url: this.url() }));
  }

  /** Raise an alert on this channel. */
  async send(title: string, options: SendOptions = {}): Promise<AlertResponse> {
    const payload = buildAlertPayload(title, options);
    const alert = parseAlertResponse(
      await this.http.request({ method: 'POST', url: this.url(), body: payload }),
    );
    checkDelivery(alert, this.throwOnZeroDelivery);
    return alert;
  }

  /**
   * Read one alert back. `null` when there is no such alert on this channel.
   *
   * The id is **either** the `customId` you invented or the `_id` the send
   * returned — a caller knows one of them and should not have to say which.
   */
  async getAlert(customIdOrAlertId: string): Promise<AlertDetail | null> {
    try {
      const raw = await this.http.request({
        method: 'GET',
        url: this.url(`/alerts/${encodeURIComponent(String(customIdOrAlertId))}`),
      });
      return parseAlertDetail(raw);
    } catch (error) {
      if (error instanceof M91NotFoundError) return null;
      throw error;
    }
  }

  /**
   * Wait until somebody takes the alert on, or the clock runs out.
   *
   * Resolves with the SHARED response that claimed it. **PERSONAL responses
   * never end this wait** — a "Seen" is an acknowledgement, not an answer, and
   * treating it as one is the mistake `decision` exists to prevent.
   *
   * Stops early and resolves `null` if the alert is closed without ever being
   * claimed: there is nothing left to wait for.
   */
  async waitForDecision(customId: string, options: WaitOptions = {}): Promise<Decision | null> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const requested = options.pollIntervalMs ?? 5000;
    if (requested < MIN_POLL_INTERVAL_MS) {
      console.warn(
        `[m91] pollIntervalMs=${requested} is below ${MIN_POLL_INTERVAL_MS}. The send link is ` +
          `rate limited to 60 requests a minute and a person cannot answer that fast; ` +
          `using ${MIN_POLL_INTERVAL_MS}ms instead.`,
      );
    }
    const interval = Math.max(requested, MIN_POLL_INTERVAL_MS);
    const deadline = this.now() + timeoutMs;

    for (;;) {
      const verdict = waitVerdict(await this.getAlert(customId));
      if (verdict.stop) return verdict.decision;

      const remaining = deadline - this.now();
      if (remaining <= 0) {
        if (options.throwOnTimeout) throw new M91TimeoutError(customId, timeoutMs);
        return null;
      }
      await this.sleep(Math.min(interval, remaining));
    }
  }

  /**
   * Close an alert this link raised. Always `true` when there is nothing open.
   *
   * A monitor that sees the problem heal closes it itself rather than waiting
   * for a person to wake up and notice.
   *
   * **404 and 403 are success.** "No such alert" and "not yours to close" both
   * mean the alert is not open on this channel, which is the state the caller
   * asked for. Anything else would make every close a branch, and every retry
   * after a dropped response a false failure.
   */
  async close(options: { customId?: string; alertId?: string }): Promise<boolean> {
    const { customId, alertId } = options ?? {};
    if (Boolean(customId) === Boolean(alertId)) {
      throw new M91ValidationError(
        `close() needs exactly one of customId or alertId — got ${customId ? 'both' : 'neither'}`,
      );
    }
    try {
      await this.http.request({
        method: 'POST',
        url: this.url('/close'),
        body: customId ? { customId } : { alertId },
      });
    } catch (error) {
      if (error instanceof M91NotFoundError || error instanceof M91ForbiddenError) return true;
      throw error;
    }
    return true;
  }

  /**
   * Ask a human, on their phone, and wait for the answer. `true` = approved.
   *
   * The shape of every human-in-the-loop gate: raise the question, block, act
   * on the answer, close the alert either way. Severity defaults to HIGH here —
   * unlike `send` — because something is *waiting* on the answer, so a phone
   * call after 45 seconds of silence is the point rather than an escalation.
   *
   * Both labels are SHARED: approving and rejecting are each a final answer
   * that settles the question for everybody, and neither is an "I saw it".
   *
   * On timeout with `timeoutMeansReject` (the default) it resolves false —
   * nobody answered, so nothing consequential happens. Set it false to get
   * `M91TimeoutError` instead. There is deliberately no way to make a timeout
   * mean approved.
   */
  async requestApproval(title: string, options: ApprovalOptions): Promise<boolean> {
    const {
      customId,
      description,
      severity = 'HIGH',
      approveLabel = 'Approve',
      rejectLabel = 'Reject',
      timeoutMs = 300_000,
      pollIntervalMs = 5000,
      timeoutMeansReject = true,
    } = options;

    await this.send(title, {
      description,
      severity,
      customId,
      isAutoClose: false,
      responseOptions: [
        { label: approveLabel, effect: 'SHARED' },
        { label: rejectLabel, effect: 'SHARED' },
      ],
    });

    try {
      const decision = await this.waitForDecision(customId, { timeoutMs, pollIntervalMs });
      if (decision === null) {
        if (!timeoutMeansReject) throw new M91TimeoutError(customId, timeoutMs);
        return false;
      }
      return isApproved(decision, approveLabel);
    } finally {
      // Answered or not, the question is no longer live. Left open, a rejected
      // deploy keeps somebody's phone in the "needs attention" list for an
      // action that already resolved.
      await this.close({ customId });
    }
  }
}

/**
 * A 2xx that woke nobody is a failure, and only the caller can decide what to do.
 *
 * `delivered` counts phones actually sent to, so this fires when a channel's
 * devices are all stale or its members have not installed the app — a case that
 * answers 201 and looks exactly like success.
 */
export function checkDelivery(alert: AlertResponse, enabled: boolean): void {
  if (!enabled || alert.actuallyReachedSomeone) return;
  throw new M91DeliveryError(
    `The alert was filed but reached nobody: delivered=0, ` +
      `unregistered=${alert.unregistered.length}, noDevice=${alert.noDevice}, ` +
      `pending=${alert.pending}. Nobody's phone rang.`,
    alert.delivered,
    alert.unregistered,
    alert.noDevice,
    alert.pending,
  );
}

/**
 * Whether one poll ends the wait. Pure, so the rule lives in one place.
 */
export function waitVerdict(detail: AlertDetail | null): { stop: boolean; decision: Decision | null } {
  // Not visible yet. A send answers before the fan-out finishes, so an
  // immediate read can outrun it; keep waiting rather than calling it gone.
  if (detail === null) return { stop: false, decision: null };
  if (detail.decision !== null) return { stop: true, decision: detail.decision };
  // Closed with nobody having claimed it — by a monitor that saw the problem
  // heal, or by hand. There is no answer coming.
  if (detail.isClosed) return { stop: true, decision: null };
  return { stop: false, decision: null };
}
