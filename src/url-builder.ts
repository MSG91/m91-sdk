/**
 * The GET form of a send: an alert spelled as a URL.
 *
 * This is the integration surface that needs no client at all. It goes in a
 * browser bar, a phone shortcut, an `<img>` tag, a cron `curl`, a smart button,
 * or any field in any tool labelled "URL to call". Somebody who has never made
 * an HTTP request in their life can raise an alert by tapping a bookmark, and
 * that is the difference between M91 being wired into something today and being
 * wired in never.
 *
 * **A bare send link raises nothing.** It is the connection test: it answers
 * with the channel's name so whoever pasted it can see they picked the right
 * one. Only a URL with `?title=` fires. That is not a default nobody got round
 * to — the token is in the path, so link previews, crawlers and mail scanners
 * fetch these routinely, and `title` having no default is the only thing
 * between a pasted link and a woken team.
 */

import { M91ValidationError } from './exceptions.js';
import {
  CUSTOM_ID_MAX,
  DESCRIPTION_MAX,
  LABEL_MAX,
  MAX_LINK_RESPONSE_OPTIONS,
  type ResponseOption,
  type Severity,
  TITLE_MAX,
  TITLE_MIN,
  checkSeverity,
  collapse,
} from './models.js';

/**
 * Validate a send link and strip anything after the token.
 *
 * Callers paste these out of the app, out of a create-channel response, or out
 * of a colleague's message, so a trailing slash, a stray query string or an
 * already-built alert URL all arrive here. All of them normalise to the bare
 * link.
 */
export function normalizeSendLink(sendLink: string): string {
  if (!sendLink || typeof sendLink !== 'string') {
    throw new M91ValidationError('sendLink is required — the full https://…/s/<token> URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(sendLink.trim());
  } catch {
    throw new M91ValidationError(
      `sendLink must be a full URL beginning http:// or https://, got '${sendLink}'`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new M91ValidationError(
      `sendLink must be a full URL beginning http:// or https://, got '${sendLink}'`,
    );
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  // Checked because the failure it prevents is silent: a URL without a token
  // authenticates as nothing and every call 401s, which reads like a revoked
  // link rather than a mistyped one.
  if (segments.length < 2 || segments[segments.length - 2] !== 's') {
    throw new M91ValidationError(
      `sendLink must look like https://m91.msg91.com/s/<token> — ` +
        `no /s/<token> found in '${parsed.pathname}'`,
    );
  }

  return `${parsed.origin}/${segments.join('/')}`;
}

/**
 * Render `respond=` from labels or response options.
 *
 * The compact syntax exists because `[{label, effect}]` cannot survive a query
 * string without becoming unreadable. So: a comma-separated list where the
 * **first label is SHARED and the rest are PERSONAL** — the shape almost every
 * real alert has, one button that takes the job for the whole group and some
 * number of "seen" buttons that do not. A trailing `!` forces SHARED on any
 * label, for the caller who wants two people able to claim.
 *
 * Two things a link cannot express, both of which throw here rather than
 * producing a URL that quietly does something else: a **PERSONAL first option**,
 * and a label that genuinely **ends in `!`**. Both are reachable with a POST.
 */
export function buildRespond(labels: Array<ResponseOption | string>): string {
  const rendered = labels.map((entry, index) => {
    let label: string;
    let marker = '';

    if (typeof entry === 'string') {
      label = collapse(entry);
    } else {
      label = collapse(entry?.label ?? '');
      const shared = (entry?.effect ?? 'SHARED') === 'SHARED';
      if (index === 0 && !shared) {
        throw new M91ValidationError(
          `the first response option in a link is always SHARED — '${label}' cannot be ` +
            'PERSONAL here. Use POST with responseOptions.',
        );
      }
      marker = shared && index > 0 ? '!' : '';
    }

    if (!label) throw new M91ValidationError('respond labels cannot be empty');
    if (label.includes(',')) {
      // The separator is a comma, so a label containing one would silently
      // become two buttons — an alert offering "Restart" and "then page Ana"
      // as separate answers.
      throw new M91ValidationError(
        `a respond label cannot contain a comma — it is the separator. ` +
          `Use POST with responseOptions for '${label}'.`,
      );
    }
    const bare = label.replace(/!+$/, '').trim();
    if (bare.length > LABEL_MAX) {
      throw new M91ValidationError(
        `response label must be ${LABEL_MAX} characters or fewer, got '${label}'`,
      );
    }
    return { rendered: label + marker, key: bare.toLowerCase() };
  });

  if (rendered.length > MAX_LINK_RESPONSE_OPTIONS) {
    throw new M91ValidationError(
      `a link can carry at most ${MAX_LINK_RESPONSE_OPTIONS} response labels, ` +
        `got ${rendered.length}. Use POST for more.`,
    );
  }
  const seen = new Set<string>();
  for (const { rendered: text, key } of rendered) {
    if (seen.has(key)) {
      throw new M91ValidationError(`cannot repeat the same response label twice: '${text}'`);
    }
    seen.add(key);
  }
  return rendered.map((r) => r.rendered).join(',');
}

export interface BuildUrlOptions {
  description?: string;
  severity?: Severity;
  customId?: string;
  /** First label is SHARED, the rest PERSONAL. Up to 6. */
  respond?: Array<ResponseOption | string>;
  isAutoClose?: boolean;
}

export interface BuildManySpec extends BuildUrlOptions {
  title: string;
}

/** Builds ready-to-paste alert URLs for tools whose only field is "URL to call". */
export class M91URLBuilder {
  readonly sendLink: string;

  constructor(sendLink: string) {
    this.sendLink = normalizeSendLink(sendLink);
  }

  /** The bare link. Answers with the channel name and **raises nothing**. */
  testUrl(): string {
    return this.sendLink;
  }

  /** A full URL that raises this alert when anything opens it. */
  build(title: string, options: BuildUrlOptions = {}): string {
    const cleanTitle = collapse(title ?? '');
    if (!cleanTitle || cleanTitle.length < TITLE_MIN) {
      throw new M91ValidationError(`title must be at least ${TITLE_MIN} characters, got '${title}'`);
    }
    if (cleanTitle.length > TITLE_MAX) {
      throw new M91ValidationError(
        `title must be ${TITLE_MAX} characters or fewer, got ${cleanTitle.length}`,
      );
    }

    const severity = checkSeverity(options.severity ?? 'MEDIUM');
    const query = new URLSearchParams();
    query.set('title', cleanTitle);

    if (options.description !== undefined && options.description !== null) {
      const description = collapse(options.description);
      if (description.length > DESCRIPTION_MAX) {
        throw new M91ValidationError(
          `description must be ${DESCRIPTION_MAX} characters or fewer, got ${description.length}`,
        );
      }
      query.set('description', description);
    }

    // MEDIUM is the server's default, so spelling it costs URL length and buys
    // nothing. These get pasted into text boxes and retyped by hand.
    if (severity !== 'MEDIUM') query.set('severity', severity);

    if (options.customId !== undefined && options.customId !== null) {
      const customId = collapse(String(options.customId));
      if (customId.length > CUSTOM_ID_MAX) {
        throw new M91ValidationError(
          `customId must be ${CUSTOM_ID_MAX} characters or fewer, got ${customId.length}`,
        );
      }
      query.set('customId', customId);
    }

    if (options.respond?.length) query.set('respond', buildRespond(options.respond));
    if (options.isAutoClose !== undefined) {
      query.set('isAutoClose', options.isAutoClose ? 'true' : 'false');
    }

    return `${this.sendLink}?${query.toString()}`;
  }

  /** One URL per spec. Each takes the same options as `build`. */
  buildMany(alerts: BuildManySpec[]): string[] {
    return alerts.map(({ title, ...options }) => {
      if (title === undefined) {
        throw new M91ValidationError("every alert in buildMany needs a 'title'");
      }
      return this.build(title, options);
    });
  }
}
