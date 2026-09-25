/** Models, local validation, the retry policy and redaction — all pure. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { waitVerdict } from '../src/client.js';
import { M91ValidationError, retryAfter, unwrap } from '../src/exceptions.js';
import { SERVER_BACKOFF, redact, retryDelay } from '../src/http.js';
import {
  buildAlertPayload,
  isApproved,
  normalizeOptions,
  parseAlertDetail,
  parseAlertResponse,
  parseChannelInfo,
  parseDecision,
  parseRecipient,
  validatePhone,
} from '../src/models.js';
import { alertPayload, detailPayload } from './helpers.js';

describe('response options', () => {
  it('defaults effect to SHARED', () => {
    assert.equal(normalizeOptions(['On it'])[0].effect, 'SHARED');
  });

  it('rejects a label over 24 characters', () => {
    // It has to read as a button at 3am.
    assert.throws(() => normalizeOptions(['x'.repeat(25)]), /24 characters/);
  });

  it('rejects an empty label', () => {
    assert.throws(() => normalizeOptions(['   ']), M91ValidationError);
  });

  it('collapses whitespace the way the server collapses it', () => {
    assert.equal(normalizeOptions(['  On   it  '])[0].label, 'On it');
  });

  it('rejects an unknown effect', () => {
    assert.throws(() => normalizeOptions([{ label: 'On it', effect: 'MAYBE' as never }]), /SHARED/);
  });
});

describe('decision', () => {
  it('matches the approval label case-insensitively', () => {
    assert.equal(isApproved(parseDecision({ label: 'approve' }), 'Approve'), true);
    assert.equal(isApproved(parseDecision({ label: 'APPROVE' }), 'Approve'), true);
  });

  it('ignores surrounding whitespace', () => {
    assert.equal(isApproved(parseDecision({ label: '  Approve ' }), 'Approve'), true);
  });

  it('does not approve on a different label', () => {
    assert.equal(isApproved(parseDecision({ label: 'Reject' }), 'Approve'), false);
  });

  it('does not approve on a null label', () => {
    // The server can hand back label: null. Treating an unknown answer as a yes
    // is the wrong way to be wrong about a payment.
    assert.equal(isApproved(parseDecision({ label: null }), 'Approve'), false);
  });

  it('parses nothing into null', () => {
    assert.equal(parseDecision(null), null);
    assert.equal(parseDecision(undefined), null);
  });

  it('carries the opaque user id', () => {
    const decision = parseDecision({ label: 'Approve', effect: 'SHARED', by: 'usr_1', at: 't' });
    assert.equal(decision?.by, 'usr_1');
    assert.equal(decision?.at, 't');
  });
});

describe('alert response', () => {
  it('defaults absent flags rather than crashing', () => {
    // The server omits deduplicated, noDevice, pending, reopened and message
    // rather than sending them false or zero.
    const alert = parseAlertResponse(alertPayload());
    assert.equal(alert.deduplicated, false);
    assert.equal(alert.reopened, false);
    assert.equal(alert.noDevice, 0);
    assert.equal(alert.pending, 0);
    assert.equal(alert.message, null);
  });

  it('counts a real delivery as reaching somebody', () => {
    assert.equal(parseAlertResponse(alertPayload({ delivered: 3 })).actuallyReachedSomeone, true);
  });

  it('counts a dedup with zero delivery as reaching somebody', () => {
    const alert = parseAlertResponse(alertPayload({ delivered: 0, deduplicated: true }));
    assert.equal(alert.actuallyReachedSomeone, true);
  });

  it('counts a plain zero delivery as reaching nobody', () => {
    assert.equal(parseAlertResponse(alertPayload({ delivered: 0 })).actuallyReachedSomeone, false);
  });

  it('parses id, status and severity', () => {
    const alert = parseAlertResponse(alertPayload({ severity: 'CRITICAL', status: 'RESOLVED' }));
    assert.equal(alert.id, '68c0a1f2e4b09c3d5f8a0001');
    assert.equal(alert.severity, 'CRITICAL');
    assert.equal(alert.status, 'RESOLVED');
  });

  it('keeps the raw body for anything new', () => {
    assert.equal(parseAlertResponse(alertPayload({ somethingNew: 1 })).raw.somethingNew, 1);
  });
});

describe('alert detail', () => {
  it('reports decided and closed', () => {
    const open = parseAlertDetail(detailPayload());
    assert.equal(open.isDecided, false);
    assert.equal(open.isClosed, false);

    assert.equal(parseAlertDetail(detailPayload({ decision: { label: 'Approve' } })).isDecided, true);

    const closed = parseAlertDetail(detailPayload({ status: 'RESOLVED', resolvedAt: 't' }));
    assert.equal(closed.isClosed, true);
    assert.equal(closed.resolvedAt, 't');
  });

  it('defaults reopenCount to zero', () => {
    const raw = detailPayload();
    delete raw.reopenCount;
    assert.equal(parseAlertDetail(raw).reopenCount, 0);
  });
});

describe('channel info and recipient', () => {
  it('parses the ping body', () => {
    const info = parseChannelInfo({
      ok: true,
      channel: { id: 'c1', name: 'Payments on-call', visibility: 'PRIVATE' },
      sender: { id: 's1', label: 'Datadog' },
    });
    assert.equal(info.name, 'Payments on-call');
    assert.equal(info.senderLabel, 'Datadog');
  });

  it('tolerates a null sender label', () => {
    const info = parseChannelInfo({ channel: { id: 'c1', name: 'n' }, sender: { label: null } });
    assert.equal(info.senderLabel, null);
    assert.equal(info.visibility, 'PRIVATE');
  });

  it('derives reachable from the state when it is absent', () => {
    assert.equal(parseRecipient({ phone: '1', state: 'accepted' }).reachable, true);
    assert.equal(parseRecipient({ phone: '1', state: 'pending' }).reachable, false);
  });
});

describe('buildAlertPayload', () => {
  it('produces the minimum body', () => {
    assert.deepEqual(buildAlertPayload('Disk full on db-1'), {
      title: 'Disk full on db-1',
      severity: 'MEDIUM',
      isAutoClose: false,
    });
  });

  it('collapses whitespace before measuring the title', () => {
    // The server collapses first too, so a 4-character title padded to 6 is a
    // 400 either way; this is just where you find out.
    assert.throws(() => buildAlertPayload('  Down  '), /at least 5/);
  });

  it('omits an optional string rather than sending null', () => {
    const body = buildAlertPayload('Disk full on db-1', { description: undefined, customId: undefined });
    assert.ok(!('description' in body));
    assert.ok(!('customId' in body));
  });

  it('rejects an empty customId rather than sending it', () => {
    assert.throws(() => buildAlertPayload('Disk full on db-1', { customId: '  ' }), /omit it/);
  });

  it('caps options at the link limit when asked', () => {
    const options = Array.from({ length: 7 }, (_, i) => `o${i}`);
    assert.throws(() => buildAlertPayload('Disk full here', { responseOptions: options }, 6), /more than 6/);
  });
});

describe('phone validation', () => {
  it('accepts a valid number', () => {
    assert.equal(validatePhone('919876543210'), '919876543210');
  });

  it('says what to do about a leading +', () => {
    assert.throws(() => validatePhone('+919876543210'), /digits only/);
  });

  for (const bad of ['9876543', '9'.repeat(16), '91 98765 43210', '91-9876543210']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => validatePhone(bad), M91ValidationError);
    });
  }
});

describe('retry policy', () => {
  it('retries a 429 once, at the delay the server asked for', () => {
    assert.equal(retryDelay(429, 1, 60), 60_000);
    assert.equal(retryDelay(429, 2, 60), null);
  });

  it('falls back to 60s with no header', () => {
    assert.equal(retryDelay(429, 1, undefined), 60_000);
  });

  it('throws rather than blocking on an absurd Retry-After', () => {
    assert.equal(retryDelay(429, 1, 3600), null);
  });

  for (const status of [500, 502, 503, 504]) {
    it(`backs off on ${status}`, () => {
      assert.deepEqual(
        [1, 2, 3, 4].map((n) => retryDelay(status, n)),
        [...SERVER_BACKOFF, null],
      );
    });
  }

  for (const status of [400, 401, 403, 404, 409, 413, 200, 201]) {
    it(`never retries ${status}`, () => {
      assert.equal(retryDelay(status, 1), null);
    });
  }

  it('reads Retry-After case-insensitively', () => {
    assert.equal(retryAfter(new Headers({ 'Retry-After': '30' })), 30);
    assert.equal(retryAfter({ 'RETRY-AFTER': '30' }), 30);
    assert.equal(retryAfter({}), undefined);
  });
});

describe('unwrap', () => {
  it('returns the inner data on success', () => {
    assert.deepEqual(unwrap(200, { success: true, data: { a: 1 } }), { a: 1 });
  });

  it('passes a non-enveloped 2xx body through', () => {
    assert.deepEqual(unwrap(200, { status: 'OK' }), { status: 'OK' });
  });

  it('carries the body code onto the error', () => {
    try {
      unwrap(404, { success: false, error: { code: 'not_a_recipient', message: 'invite first' } });
      assert.fail('should have thrown');
    } catch (error) {
      assert.equal((error as { code: string }).code, 'not_a_recipient');
    }
  });
});

describe('redact', () => {
  it('replaces the token', () => {
    assert.equal(redact('https://m91.msg91.com/s/tok_secret'), 'https://m91.msg91.com/s/***');
  });

  it('drops the query string too', () => {
    // A GET-form send carries the title, and titles name customers and hosts.
    assert.equal(
      redact('https://m91.msg91.com/s/tok_secret?title=Acme+prod+down'),
      'https://m91.msg91.com/s/***',
    );
  });

  it('leaves subpaths addressable', () => {
    assert.equal(
      redact('https://m91.msg91.com/s/tok_secret/alerts/disk-full'),
      'https://m91.msg91.com/s/***/alerts/disk-full',
    );
  });

  it('masks a token buried in a runtime error message', () => {
    // A fetch failure can name the URL in its own text, so redacting only the
    // half the SDK writes still ships the token. Found by running the demo.
    const leaky =
      "request to https://m91.msg91.com/s/tok_62b16becab87 failed, reason: ECONNREFUSED";
    const cleaned = redact(leaky);
    assert.ok(!cleaned.includes('tok_62b16becab87'));
    assert.ok(cleaned.includes('ECONNREFUSED'), 'must not eat the rest of the message');
  });

  it('masks a token with a query string mid-sentence', () => {
    const cleaned = redact('failed on https://m91.msg91.com/s/tok_x?title=Acme+down after 3 tries');
    assert.ok(!cleaned.includes('tok_x'));
    assert.ok(!cleaned.includes('Acme'));
    assert.ok(cleaned.endsWith('after 3 tries'));
  });

  it('leaves a URL with no token alone', () => {
    assert.equal(redact('https://m91.msg91.com/api/v1/alerts'), 'https://m91.msg91.com/api/v1/alerts');
  });
});

describe('waitVerdict', () => {
  it('keeps waiting while the alert is not visible', () => {
    assert.deepEqual(waitVerdict(null), { stop: false, decision: null });
  });

  it('stops on a decision', () => {
    const detail = parseAlertDetail(detailPayload({ decision: { label: 'Approve' } }));
    assert.equal(waitVerdict(detail).stop, true);
  });

  it('stops on a close with no decision', () => {
    const detail = parseAlertDetail(detailPayload({ status: 'RESOLVED' }));
    assert.deepEqual(waitVerdict(detail), { stop: true, decision: null });
  });

  it('keeps waiting through PERSONAL responses', () => {
    // "Seen" is an acknowledgement, not an answer.
    const detail = parseAlertDetail(
      detailPayload({ responses: [{ label: 'Seen', effect: 'PERSONAL' }] }),
    );
    assert.deepEqual(waitVerdict(detail), { stop: false, decision: null });
  });
});
