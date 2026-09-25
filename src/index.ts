/**
 * M91 — wake a human when software cannot carry on alone.
 *
 * An alert rings every phone in a channel at full volume, through silent mode
 * and Do Not Disturb, and keeps ringing until somebody answers. HIGH and
 * CRITICAL place a voice call if 45 seconds pass with no answer. Whoever takes
 * it on is recorded, and it clears for everyone else.
 *
 * ```ts
 * import { M91Client } from 'm91';
 *
 * const m91 = new M91Client(process.env.M91_SEND_LINK!);
 * await m91.verify();                              // raises nothing; names the channel
 * await m91.send('Payments API is down', { severity: 'CRITICAL', customId: 'payments-down' });
 * await m91.close({ customId: 'payments-down' });
 * ```
 *
 * And the reason an agent wants it — a question that blocks until a person
 * answers on their phone:
 *
 * ```ts
 * if (await m91.requestApproval('Refund 48,000 on ORD-40122?', { customId: 'refund-ORD-40122' })) {
 *   await processRefund();
 * }
 * ```
 *
 * Everything here is a convenience over one URL. The send link works from a
 * browser bar, a cron `curl` or an `<img>` tag with no client at all, and
 * `M91URLBuilder` is for exactly those.
 */

export { M91Client } from './client.js';
export type { ApprovalOptions, ClientOptions, SendOptions, WaitOptions } from './client.js';

export { M91Platform, DEFAULT_BASE_URL } from './platform.js';
export type { PlatformOptions } from './platform.js';

export { M91URLBuilder, normalizeSendLink } from './url-builder.js';
export type { BuildManySpec, BuildUrlOptions } from './url-builder.js';

export { redact } from './http.js';

export {
  M91Error,
  M91ValidationError,
  M91AuthError,
  M91ForbiddenError,
  M91NotFoundError,
  M91ChannelEmptyError,
  M91RateLimitError,
  M91ServerError,
  M91NetworkError,
  M91DeliveryError,
  M91TimeoutError,
} from './exceptions.js';

export {
  SEVERITIES,
  EFFECTS,
  ESCALATING_SEVERITIES,
  isApproved,
  validatePhone,
  buildAlertPayload,
} from './models.js';

export type {
  AlertDetail,
  AlertResponse,
  AlertStatus,
  ApiKeyInfo,
  ChannelInfo,
  Decision,
  Effect,
  InviteResult,
  ProvisionedChannel,
  Recipient,
  RecipientState,
  ResponseOption,
  Severity,
} from './models.js';

export const VERSION = '1.0.0';
