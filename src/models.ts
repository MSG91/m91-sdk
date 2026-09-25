/**
 * Every shape the API returns, plus the local validation that stops a doomed
 * request before it leaves the process.
 *
 * Two rules govern this file:
 *
 * - **Parse defensively.** The server omits a field rather than sending it
 *   false or zero — `deduplicated`, `noDevice`, `pending`, `reopened` and
 *   `message` are present only when they have something to say.
 * - **Emit exactly.** Every request schema server-side is `.strict()`: an
 *   unknown field is a 400, and so is `null` where a string was declared. So
 *   `buildAlertPayload` *omits* what the caller left unset.
 */

import { M91ValidationError } from './exceptions.js';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Effect = 'SHARED' | 'PERSONAL';
export type AlertStatus = 'OPEN' | 'RESOLVED';
export type RecipientState = 'pending' | 'accepted' | 'declined';

export const SEVERITIES: readonly Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const EFFECTS: readonly Effect[] = ['SHARED', 'PERSONAL'] as const;

/** Severities that place a voice call after 45s with no answer. */
export const ESCALATING_SEVERITIES: readonly Severity[] = ['HIGH', 'CRITICAL'] as const;

export const TITLE_MIN = 5;
export const TITLE_MAX = 2000;
export const DESCRIPTION_MAX = 2000;
export const CUSTOM_ID_MAX = 200;
export const LABEL_MAX = 24;
export const MAX_RESPONSE_OPTIONS = 20;
export const MAX_LINK_RESPONSE_OPTIONS = 6;
export const CHANNEL_NAME_MAX = 80;
export const MAX_MEMBERS_PER_CALL = 500;

/** Mirrors `validation/common.js` — digits only, country code included, no `+`. */
const PHONE_RE = /^\d{8,15}$/;

/**
 * One button on the alert screen.
 *
 * `label` is capped at 24 characters because it has to read as a button at 3am,
 * not for any storage reason. `effect` defaults to SHARED, as it does
 * server-side.
 */
export interface ResponseOption {
  label: string;
  effect?: Effect;
}

/**
 * The SHARED response that claimed the alert — the one field an agent reads.
 *
 * **Only a SHARED response sets this.** A PERSONAL one is an acknowledgement,
 * and reading it as an answer would let "Seen" mean "Approved". Never reduce
 * `responses` yourself to work out who decided.
 *
 * `label` can be null: the server returns null when an alert was claimed
 * without an option being chosen. `by` is an opaque user id — never a phone
 * number, never a name.
 */
export interface Decision {
  label: string | null;
  effect: string;
  at: string | null;
  by: string | null;
}

/** What a send returns. 201 for a new alert, 200 for a suppressed repeat. */
export interface AlertResponse {
  id: string;
  channelId: string | null;
  channelName: string | null;
  status: AlertStatus;
  severity: Severity;
  customId: string | null;
  isAutoClose: boolean;
  responseOptions: ResponseOption[];
  /**
   * Phones actually sent to — **not** the size of the roster. This reported the
   * roster count until a reinstalled phone with a stale token showed the gap.
   */
  delivered: number;
  createdAt: string | null;
  /** The same customId was already open, or an identical payload arrived within 5s. */
  deduplicated: boolean;
  reopened: boolean;
  /** Invited numbers with no M91 account at all. */
  unregistered: string[];
  /** Accepted and signed in, but with no device registered. */
  noDevice: number;
  /** Invited and never answered. */
  pending: number;
  message: string | null;
  /**
   * The check to assert on, rather than "the request succeeded". A deduplicated
   * send delivers to nobody *because the alert is already open and ringing*.
   */
  actuallyReachedSomeone: boolean;
  raw: Record<string, unknown>;
}

/** What a read-back returns. Poll `decision`, never `responses[0]`. */
export interface AlertDetail {
  id: string;
  customId: string | null;
  status: AlertStatus;
  severity: Severity;
  title: string | null;
  isAutoClose: boolean;
  reopenCount: number;
  responseOptions: ResponseOption[];
  /** Every response, personal and shared. Not how you decide anything. */
  responses: unknown[];
  decision: Decision | null;
  resolvedAt: string | null;
  createdAt: string | null;
  isDecided: boolean;
  isClosed: boolean;
  raw: Record<string, unknown>;
}

/**
 * What a bare GET on a send link answers with. The channel *name* is the point:
 * it lets whoever pasted the URL see they picked the right channel.
 */
export interface ChannelInfo {
  id: string;
  name: string;
  visibility: string;
  /** Which send link fired, by label. A channel can hold several, one per system. */
  senderLabel: string | null;
  senderId: string | null;
}

/**
 * What an API key is, without doing anything with it.
 *
 * The answer to the question somebody actually has on a connection screen — not
 * "is this valid" but **which** key did I just paste and whose authority does it
 * carry. Enough to render "Connected as +91 98765 43210 · Production" rather
 * than a tick.
 *
 * `prefix` is the first characters of the key, which is what the app shows so a
 * person can tell two keys apart. The key itself is never returned by anything.
 */
export interface ApiKeyInfo {
  keyId: string;
  prefix: string | null;
  label: string | null;
  createdAt: string | null;
  /**
   * The owner's phone. No user id on purpose: it is an internal handle, and a
   * platform storing it would be storing something it can never use.
   */
  ownerPhone: string | null;
}

export interface Recipient {
  phone: string;
  state: RecipientState;
  /** Only an accepted recipient can be woken through Do Not Disturb. */
  reachable: boolean;
}

/**
 * A team channel created by API key. `sendLink` is how it is *alerted* — an API
 * key never can be. Store it the moment you get it: creating a channel is not
 * idempotent, so a lost response is an orphaned channel, not something to retry.
 */
export interface ProvisionedChannel {
  id: string;
  name: string;
  sendLink: string | null;
}

/** The four buckets an invite call sorts phones into. */
export interface InviteResult {
  invited: string[];
  already: string[];
  pending: string[];
  declined: string[];
  raw: Record<string, unknown>;
}

// ── parsing ───────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

const asRaw = (value: unknown): Raw => (value && typeof value === 'object' ? (value as Raw) : {});
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const num = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function parseOptions(value: unknown): ResponseOption[] {
  return arr(value).map((o) => {
    const raw = asRaw(o);
    return { label: String(raw.label ?? ''), effect: (raw.effect as Effect) ?? 'SHARED' };
  });
}

export function parseDecision(value: unknown): Decision | null {
  if (!value || typeof value !== 'object') return null;
  const raw = asRaw(value);
  return {
    label: str(raw.label),
    effect: String(raw.effect ?? 'SHARED'),
    at: str(raw.at),
    by: str(raw.by),
  };
}

export function parseAlertResponse(value: unknown): AlertResponse {
  const raw = asRaw(value);
  const delivered = num(raw.delivered);
  const deduplicated = raw.deduplicated === true;
  return {
    id: String(raw._id ?? raw.id ?? ''),
    channelId: str(raw.channelId),
    channelName: str(raw.channelName),
    status: (raw.status as AlertStatus) ?? 'OPEN',
    severity: (raw.severity as Severity) ?? 'MEDIUM',
    customId: str(raw.customId),
    isAutoClose: raw.isAutoClose === true,
    responseOptions: parseOptions(raw.responseOptions),
    delivered,
    createdAt: str(raw.createdAt),
    deduplicated,
    reopened: raw.reopened === true,
    unregistered: arr(raw.unregistered).map(String),
    noDevice: num(raw.noDevice),
    pending: num(raw.pending),
    message: str(raw.message),
    actuallyReachedSomeone: deduplicated || delivered > 0,
    raw,
  };
}

export function parseAlertDetail(value: unknown): AlertDetail {
  const raw = asRaw(value);
  const decision = parseDecision(raw.decision);
  const status = (raw.status as AlertStatus) ?? 'OPEN';
  return {
    id: String(raw._id ?? raw.id ?? ''),
    customId: str(raw.customId),
    status,
    severity: (raw.severity as Severity) ?? 'MEDIUM',
    title: str(raw.title),
    isAutoClose: raw.isAutoClose === true,
    reopenCount: num(raw.reopenCount),
    responseOptions: parseOptions(raw.responseOptions),
    responses: arr(raw.responses),
    decision,
    resolvedAt: str(raw.resolvedAt),
    createdAt: str(raw.createdAt),
    isDecided: decision !== null,
    isClosed: status === 'RESOLVED',
    raw,
  };
}

export function parseChannelInfo(value: unknown): ChannelInfo {
  const raw = asRaw(value);
  const channel = asRaw(raw.channel);
  const sender = asRaw(raw.sender);
  return {
    id: String(channel.id ?? ''),
    name: String(channel.name ?? ''),
    visibility: String(channel.visibility ?? 'PRIVATE'),
    senderLabel: str(sender.label),
    senderId: str(sender.id),
  };
}

export function parseApiKeyInfo(value: unknown): ApiKeyInfo {
  const raw = asRaw(value);
  const key = asRaw(raw.key);
  const owner = asRaw(raw.owner);
  return {
    keyId: String(key._id ?? key.id ?? ''),
    prefix: str(key.prefix),
    label: str(key.label),
    createdAt: str(key.createdAt),
    ownerPhone: str(owner.phone),
  };
}

export function parseRecipient(value: unknown): Recipient {
  const raw = asRaw(value);
  const state = (raw.state as RecipientState) ?? 'pending';
  return {
    phone: String(raw.phone ?? ''),
    state,
    reachable: raw.reachable === undefined ? state === 'accepted' : raw.reachable === true,
  };
}

export function parseProvisionedChannel(value: unknown): ProvisionedChannel {
  const raw = asRaw(value);
  return {
    id: String(raw._id ?? raw.id ?? ''),
    name: String(raw.name ?? ''),
    sendLink: str(raw.sendLink),
  };
}

export function parseInviteResult(value: unknown): InviteResult {
  const raw = asRaw(value);
  return {
    invited: arr(raw.invited).map(String),
    already: arr(raw.already).map(String),
    pending: arr(raw.pending).map(String),
    declined: arr(raw.declined).map(String),
    raw,
  };
}

/** True when this decision is the approval, compared case-insensitively.
 *
 * A missing label is not an approval. The server can hand back `label: null`,
 * and treating an unknown answer as a yes is the wrong way to be wrong about a
 * payment. */
export function isApproved(decision: Decision | null, approveLabel = 'Approve'): boolean {
  if (!decision?.label) return false;
  return collapse(decision.label).toLowerCase() === collapse(approveLabel).toLowerCase();
}

// ── outbound ──────────────────────────────────────────────────────────────────

/**
 * Trim and collapse runs of whitespace, as `validateRequest` does server-side.
 * Done here too so a length check measures the string the server will measure.
 */
export function collapse(value: string): string {
  return String(value).replace(/\s+/g, ' ').trim();
}

export interface AlertFields {
  description?: string;
  severity?: Severity;
  customId?: string;
  isAutoClose?: boolean;
  responseOptions?: Array<ResponseOption | string>;
}

/**
 * Validate an alert locally and render the JSON body the server accepts.
 *
 * Every limit checked here is one the server enforces. Checking twice is not
 * duplication for its own sake: a 400 costs a round trip, and the caller is
 * often a cron or an agent that will simply do it again.
 */
export function buildAlertPayload(
  title: string,
  fields: AlertFields = {},
  maxOptions = MAX_RESPONSE_OPTIONS,
): Record<string, unknown> {
  const cleanTitle = collapse(title ?? '');
  if (!cleanTitle) throw new M91ValidationError('title is required');
  if (cleanTitle.length < TITLE_MIN) {
    throw new M91ValidationError(
      `title must be at least ${TITLE_MIN} characters, got ${cleanTitle.length}`,
    );
  }
  if (cleanTitle.length > TITLE_MAX) {
    throw new M91ValidationError(
      `title must be ${TITLE_MAX} characters or fewer, got ${cleanTitle.length}`,
    );
  }

  const severity = checkSeverity(fields.severity ?? 'MEDIUM');
  const payload: Record<string, unknown> = { title: cleanTitle, severity };

  if (fields.description !== undefined && fields.description !== null) {
    const description = collapse(fields.description);
    if (description.length > DESCRIPTION_MAX) {
      throw new M91ValidationError(
        `description must be ${DESCRIPTION_MAX} characters or fewer, got ${description.length}`,
      );
    }
    payload.description = description;
  }

  if (fields.customId !== undefined && fields.customId !== null) {
    const customId = collapse(String(fields.customId));
    if (!customId) throw new M91ValidationError('customId cannot be empty — omit it instead');
    if (customId.length > CUSTOM_ID_MAX) {
      throw new M91ValidationError(
        `customId must be ${CUSTOM_ID_MAX} characters or fewer, got ${customId.length}`,
      );
    }
    payload.customId = customId;
  }

  // Always sent, never omitted. The default is false on both sides, but an
  // explicit false is what lets a code review of the call site tell "stays open
  // until somebody closes it" from "nobody thought about it".
  payload.isAutoClose = fields.isAutoClose === true;

  if (fields.responseOptions !== undefined) {
    payload.responseOptions = checkOptions(normalizeOptions(fields.responseOptions), maxOptions);
  }

  return payload;
}

export function normalizeOptions(options: Array<ResponseOption | string>): ResponseOption[] {
  return options.map((option) => {
    const raw = typeof option === 'string' ? { label: option } : option;
    const label = collapse(raw?.label ?? '');
    if (!label) throw new M91ValidationError('response option label cannot be empty');
    if (label.length > LABEL_MAX) {
      throw new M91ValidationError(
        `response option label must be ${LABEL_MAX} characters or fewer, got ${label.length}: '${label}'`,
      );
    }
    const effect = raw.effect ?? 'SHARED';
    if (!EFFECTS.includes(effect)) {
      throw new M91ValidationError(`effect must be SHARED or PERSONAL, got '${effect}'`);
    }
    return { label, effect };
  });
}

function checkOptions(options: ResponseOption[], maxOptions: number): ResponseOption[] {
  if (options.length > maxOptions) {
    throw new M91ValidationError(
      `cannot offer more than ${maxOptions} response options, got ${options.length}`,
    );
  }
  const seen = new Set<string>();
  for (const option of options) {
    const key = option.label.toLowerCase();
    // The server rejects this too. Two buttons reading the same thing with
    // different effects is an alert nobody can answer correctly at 3am.
    if (seen.has(key)) {
      throw new M91ValidationError(`cannot repeat the same response label twice: '${option.label}'`);
    }
    seen.add(key);
  }
  return options;
}

export function checkSeverity(severity: string): Severity {
  const value = String(severity).toUpperCase() as Severity;
  if (!SEVERITIES.includes(value)) {
    throw new M91ValidationError(`severity must be one of: ${SEVERITIES.join(', ')}, got '${severity}'`);
  }
  return value;
}

/**
 * Digits only, 8–15, country code included, no `+` and no spaces.
 * The `+` is the one everybody gets wrong, so it gets its own message.
 */
export function validatePhone(phone: string): string {
  const raw = String(phone ?? '').trim();
  if (raw.startsWith('+')) {
    throw new M91ValidationError(
      `phone must not start with '+': send digits only, e.g. '${raw.slice(1)}' not '${raw}'`,
    );
  }
  if (!PHONE_RE.test(raw)) {
    throw new M91ValidationError(
      `phone must be 8-15 digits including the country code, with no '+' or spaces ` +
        `(e.g. 919876543210), got '${phone}'`,
    );
  }
  return raw;
}
