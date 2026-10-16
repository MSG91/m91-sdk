/**
 * The API-key client: alerting **one person, by phone number**.
 *
 * The narrowness is the point, and worth understanding before reaching for
 * this. A team is already solved — somebody creates the channel in the app and
 * the integration posts to its send link. What a link cannot do is address a
 * person a platform is discovering at runtime: a CRM signing up its
 * five-thousandth salesman cannot mint and store five thousand bearer
 * credentials, each able to wake somebody through Do Not Disturb, sitting in a
 * user table with no rotation. So for one person, the secret is one header and
 * the address is a phone number.
 *
 * **An API key cannot alert a team channel.** It can *provision* one — create
 * it, staff it, read its send link — because that is the same authority its
 * owner has in the app. Raising the alert is still the send link's job. A
 * leaked key can rename or restaff a channel; it cannot ring a single phone in
 * it, and that split is the entire reason the two capabilities sit on two
 * credentials.
 */

import { M91ForbiddenError, M91NotFoundError, M91ValidationError } from './exceptions.js';
import { Transport, type TransportOptions } from './http.js';
import {
  type AlertDetail,
  type AlertResponse,
  type ApiKeyInfo,
  CHANNEL_NAME_MAX,
  type InviteResult,
  MAX_MEMBERS_PER_CALL,
  type ProvisionedChannel,
  type Recipient,
  buildAlertPayload,
  collapse,
  parseAlertDetail,
  parseAlertResponse,
  parseApiKeyInfo,
  parseInviteResult,
  parseProvisionedChannel,
  parseRecipient,
  validatePhone,
} from './models.js';
import { type SendOptions, checkDelivery } from './client.js';

export const DEFAULT_BASE_URL = 'https://m91-api.msg91.com';
export const API_KEY_PREFIX = 'm91sk_';

export interface PlatformOptions extends TransportOptions {
  baseUrl?: string;
  /**
   * Throw `M91DeliveryError` when an alert reaches nobody. On by default, for
   * the same reason as on `M91Client` — and it bites harder here. A direct
   * alert has a roster of exactly one, so one stale device token is the
   * difference between waking somebody and waking nobody, and the API still
   * answers 201.
   */
  throwOnZeroDelivery?: boolean;
}

/** Invite people, alert them one at a time, and provision team channels. */
export class M91Platform {
  readonly baseUrl: string;
  readonly throwOnZeroDelivery: boolean;
  private readonly apiKey: string;
  private readonly http: Transport;

  constructor(apiKey: string, options: PlatformOptions = {}) {
    this.apiKey = checkApiKey(apiKey);
    this.throwOnZeroDelivery = options.throwOnZeroDelivery !== false;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.http = new Transport({
      ...options,
      headers: { authorization: `Bearer ${this.apiKey}`, ...options.headers },
    });
  }

  /** The key is a live credential that can wake people. Only its prefix. */
  toString(): string {
    return `M91Platform(${this.apiKey.slice(0, 10)}…, ${this.baseUrl})`;
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  /**
   * Check the key works, and see which key it is. **Alerts nobody.**
   *
   * The only route on this surface that is safe to call just to find out
   * whether a credential works — everything else writes something or needs an
   * id that already exists. On an alerting product, "test the connection" must
   * never mean "wake somebody", so do not verify a key by sending an alert.
   *
   * A revoked key never reaches this route, so a success means *live*, not
   * merely well-formed.
   *
   * Note what it does **not** prove: a perfectly good key with nobody accepted
   * behind it still alerts nobody. Invite a real number and check the state
   * before you believe the integration works.
   */
  async verify(): Promise<ApiKeyInfo> {
    return parseApiKeyInfo(await this.http.request({ method: 'GET', url: this.url('/me') }));
  }

  /**
   * Invite somebody to accept direct alerts. **Idempotent.**
   *
   * Keyed on the phone number, so calling it on every login is safe and is the
   * intended usage — retries cannot produce a second channel.
   *
   * The returned `state` needs different handling in each case, and the
   * important one is that only `accepted` can actually be woken. A `pending`
   * recipient has been asked and has not answered: nag them in your own UI, do
   * not re-invite them in a loop. `declined` is terminal — no API re-invites a
   * declined number, and only they can undo it from their own app.
   *
   * Inviting is deliberately separate from alerting: **an alert must never be
   * what invites somebody**, because an invited person is not an M91 user yet
   * and the urgent thing would arrive as an ordinary message that does not
   * pierce Do Not Disturb, does not repeat and does not escalate.
   *
   * `label` is **the name the person sees on the alert**, not a name for the
   * person. It is the only thing on their screen saying where the alert came
   * from, so it should be your product — "Acme CRM", not "Priya" and not an id.
   * Woken at 3am, "Acme CRM" answers the question they have and their own name
   * does not.
   *
   * Two things follow, and both bite: it defaults to `"Direct alerts"` when
   * omitted, and **every invite overwrites it**. Since this call belongs in
   * your login handler, omitting the label on the second login resets a good
   * name back to the default. Pass the same constant every time.
   */
  async inviteRecipient(phone: string, label?: string): Promise<Recipient> {
    const body: Record<string, unknown> = { phone: validatePhone(phone) };
    if (label !== undefined && label !== null && collapse(label)) body.label = collapse(label);
    return parseRecipient(await this.http.request({ method: 'POST', url: this.url('/recipients'), body }));
  }

  /**
   * Stop alerting somebody. `true` when they are no longer a recipient.
   *
   * Worth wiring to whatever your system calls offboarding. Nothing in an
   * integration is as routinely forgotten, and forgetting it means somebody who
   * left the company is still woken at 3am.
   */
  async removeRecipient(phone: string): Promise<boolean> {
    return this.tolerateMissing({
      method: 'DELETE',
      url: this.url(`/recipients/${encodeURIComponent(validatePhone(phone))}`),
    });
  }

  /**
   * Wake one person. They must have been invited **and have accepted**.
   *
   * Alerting a number nobody invited throws `M91NotFoundError`, never a silent
   * invitation.
   *
   * A direct alert *is* a channel with one member, so responses, escalation,
   * deduplication and the consent gate behave exactly as they do for a team —
   * there is no second implementation to keep in step.
   */
  async alertPerson(phone: string, title: string, options: SendOptions = {}): Promise<AlertResponse> {
    const body = buildAlertPayload(title, options);
    body.phone = validatePhone(phone);
    const alert = parseAlertResponse(
      await this.http.request({ method: 'POST', url: this.url('/alerts'), body }),
    );
    // The same guard the send link gets. A person who reinstalled their phone
    // still has an account and still shows as an accepted recipient, so this
    // path answers 201 with delivered: 0 and looks exactly like success — and
    // with one recipient there is nobody else it reached.
    checkDelivery(alert, this.throwOnZeroDelivery);
    return alert;
  }

  /**
   * Read back what one person decided. `null` if there is no such alert.
   * `alertId` is the `customId` you invented or the `_id` a send returned.
   */
  async getAlert(alertId: string, phone: string): Promise<AlertDetail | null> {
    try {
      const raw = await this.http.request({
        method: 'GET',
        url: this.url(`/alerts/${encodeURIComponent(String(alertId))}`),
        query: { phone: validatePhone(phone) },
      });
      return parseAlertDetail(raw);
    } catch (error) {
      if (error instanceof M91NotFoundError) return null;
      throw error;
    }
  }

  /**
   * Close one person's alert.
   *
   * **404 and 403 are success**, as on the send link: "no such alert" and
   * "already resolved" both mean it is not open, which is what was asked for.
   */
  async closeAlert(
    phone: string,
    options: { customId?: string; alertId?: string },
  ): Promise<boolean> {
    const { customId, alertId } = options ?? {};
    if (Boolean(customId) === Boolean(alertId)) {
      throw new M91ValidationError(
        `closeAlert() needs exactly one of customId or alertId — got ${customId ? 'both' : 'neither'}`,
      );
    }
    try {
      await this.http.request({
        method: 'POST',
        url: this.url('/alerts/close'),
        body: { phone: validatePhone(phone), ...(customId ? { customId } : { alertId }) },
      });
    } catch (error) {
      // 403 as well as 404, matching M91Client.close(). Production answers 403
      // `already_resolved` when the alert is closed already, and "it is closed"
      // is the state the caller asked for. Only close gets this: on a REMOVE a
      // 403 means the channel is not yours, which must not be swallowed.
      if (error instanceof M91NotFoundError || error instanceof M91ForbiddenError) return true;
      throw error;
    }
    return true;
  }

  /**
   * Create a team channel and get back the send link that alerts it.
   *
   * **Not idempotent, and deliberately takes no id of your own to make it so.**
   * Calling this twice makes two channels. Store the returned `id` and
   * `sendLink` against your own team the moment you get them — a lost response
   * is an orphaned channel, not something to retry.
   *
   * `alertOwner: false` skips adding the key's owner as a member: a platform
   * minting one channel per customer team has no reason for its own account to
   * be paged for every one of them. They stay the owner either way.
   */
  /**
   * Every team channel this key can raise an alert on.
   *
   * The missing half of {@link createChannel}, which is **not idempotent**: a
   * platform that lost the response to a create had an orphaned channel and no
   * way to find it. Now it can read back what it already has.
   *
   * **Scoped by send access, not by ownership.** Every row carries a
   * `sendLink`, so the list answers "what can I alert?" — which includes a
   * channel whose owner granted this person send access, not only the ones they
   * created. Creating a channel grants its owner send access too, so owned
   * channels are a subset of this rather than a separate case.
   *
   * Channels they merely joined stay absent: being a member means you get
   * woken, not that you may wake others. Archived channels are left out, since
   * a link that cannot alert anybody is worse than no link.
   */
  async listChannels(): Promise<ProvisionedChannel[]> {
    const rows = await this.http.request({ method: 'GET', url: this.url('/channels') });
    return (Array.isArray(rows) ? rows : []).map(parseProvisionedChannel);
  }

  async createChannel(name: string, alertOwner = true): Promise<ProvisionedChannel> {
    const clean = collapse(name ?? '');
    if (!clean) throw new M91ValidationError('channel name is required');
    if (clean.length > CHANNEL_NAME_MAX) {
      throw new M91ValidationError(
        `channel name must be ${CHANNEL_NAME_MAX} characters or fewer, got ${clean.length}`,
      );
    }
    return parseProvisionedChannel(
      await this.http.request({
        method: 'POST',
        url: this.url('/channels'),
        body: { name: clean, alertOwner: alertOwner !== false },
      }),
    );
  }

  /**
   * Invite people into a team channel. Up to 500 per call.
   *
   * Adding somebody to the roster is not the same as being able to alert them:
   * they are invited, and an invitation is theirs to accept.
   */
  async addMembers(channelId: string, phones: string[]): Promise<InviteResult> {
    return parseInviteResult(
      await this.http.request({
        method: 'POST',
        url: this.url(`/channels/${encodeURIComponent(String(channelId))}/members`),
        body: { phones: checkPhones(phones) },
      }),
    );
  }

  /** Take somebody off a team channel's roster. */
  async removeMember(channelId: string, phone: string): Promise<boolean> {
    return this.tolerateMissing({
      method: 'DELETE',
      url: this.url(
        `/channels/${encodeURIComponent(String(channelId))}/members/${encodeURIComponent(validatePhone(phone))}`,
      ),
    });
  }

  /** Already-not-there is the state the caller asked for. */
  private async tolerateMissing(request: Parameters<Transport['request']>[0]): Promise<boolean> {
    try {
      await this.http.request(request);
    } catch (error) {
      if (error instanceof M91NotFoundError) return true;
      throw error;
    }
    return true;
  }
}

/**
 * An API key is told apart from a mobile JWT by its prefix, server-side. So a
 * key without it never reaches the key verifier at all, and comes back as a
 * bare 401 that looks like revocation. Checked here to say what is actually
 * wrong.
 */
export function checkApiKey(apiKey: string): string {
  const key = String(apiKey ?? '').trim();
  if (!key) throw new M91ValidationError('apiKey is required');
  if (!key.startsWith(API_KEY_PREFIX)) {
    throw new M91ValidationError(
      `apiKey must start with '${API_KEY_PREFIX}' — mint one in the M91 app. ` +
        'A mobile JWT will not work here.',
    );
  }
  return key;
}

export function checkPhones(phones: string[]): string[] {
  if (!phones?.length) throw new M91ValidationError('phones needs at least one number');
  if (phones.length > MAX_MEMBERS_PER_CALL) {
    throw new M91ValidationError(
      `cannot invite more than ${MAX_MEMBERS_PER_CALL} numbers at once, got ${phones.length}. ` +
        'Send them in batches.',
    );
  }
  return phones.map(validatePhone);
}
