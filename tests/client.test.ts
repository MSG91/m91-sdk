/** M91Client — the send-link surface. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { M91Client, type ClientOptions } from '../src/client.js';
import {
  M91AuthError,
  M91ChannelEmptyError,
  M91DeliveryError,
  M91NetworkError,
  M91RateLimitError,
  M91ServerError,
  M91TimeoutError,
  M91ValidationError,
} from '../src/exceptions.js';
import {
  Recorder,
  SEND_LINK,
  alertPayload,
  detailPayload,
  err,
  ok,
  unreachableFetch,
} from './helpers.js';

const client = (rec: Recorder, extra: ClientOptions = {}) =>
  new M91Client(SEND_LINK, { ...rec.options, ...extra });

describe('construction', () => {
  it('accepts a full send link', () => {
    assert.equal(new M91Client(SEND_LINK).sendLink, SEND_LINK);
  });

  it('strips a trailing slash and an existing query', () => {
    assert.equal(new M91Client(`${SEND_LINK}/?title=old`).sendLink, SEND_LINK);
  });

  it('rejects an empty link', () => {
    assert.throws(() => new M91Client(''), M91ValidationError);
  });

  it('rejects a link with no /s/ segment', () => {
    assert.throws(() => new M91Client('https://m91.msg91.com/send/tok_abc'), /\/s\//);
  });

  it('rejects something that is not a URL', () => {
    assert.throws(() => new M91Client('tok_abc'), /full URL/);
  });

  it('never shows the token when stringified', () => {
    // The token is the credential and it lives in the path, so a string in a
    // log or a crash report would be a leaked pager.
    const text = String(new M91Client(SEND_LINK));
    assert.ok(!text.includes('tok_test123'));
    assert.match(text, /\/s\/\*\*\*/);
  });
});

describe('verify', () => {
  it('returns the channel', async () => {
    const rec = new Recorder().push(
      ok({
        ok: true,
        channel: { id: 'c1', name: 'Payments on-call', visibility: 'PRIVATE' },
        sender: { id: 's1', label: 'Datadog' },
      }),
    );
    const info = await client(rec).verify();
    assert.equal(info.name, 'Payments on-call');
    assert.equal(info.senderLabel, 'Datadog');
  });

  it('is a bare GET and raises no alert', async () => {
    const rec = new Recorder().push(ok({ channel: { id: 'c1', name: 'n' }, sender: {} }));
    await client(rec).verify();
    assert.equal(rec.last.method, 'GET');
    assert.equal(rec.last.url, SEND_LINK);
    assert.equal(rec.last.body, undefined);
  });

  it('maps 401 to M91AuthError', async () => {
    const rec = new Recorder().push(err('UNAUTHORIZED', 'Invalid sender token', 401));
    await assert.rejects(client(rec).verify(), M91AuthError);
  });
});

describe('send', () => {
  it('reports how many phones were reached', async () => {
    const rec = new Recorder().push(ok(alertPayload({ delivered: 4 }), 201));
    const alert = await client(rec).send('Database disk 90% full on node-7');
    assert.equal(alert.delivered, 4);
    assert.equal(alert.actuallyReachedSomeone, true);
  });

  it('defaults severity to MEDIUM', async () => {
    // MEDIUM, never HIGH: HIGH places voice calls, so "I didn't specify" must
    // not mean "ring everyone".
    const rec = new Recorder().push(ok(alertPayload(), 201));
    await client(rec).send('Database disk 90% full');
    assert.equal(rec.bodyOf(0).severity, 'MEDIUM');
  });

  it('sends isAutoClose explicitly as false', async () => {
    const rec = new Recorder().push(ok(alertPayload(), 201));
    await client(rec).send('Database disk 90% full');
    assert.equal(rec.bodyOf(0).isAutoClose, false);
  });

  it('omits unset fields rather than sending null', async () => {
    // Every schema server-side is .strict(); a declared string field given null
    // is a 400, not a silent drop.
    const rec = new Recorder().push(ok(alertPayload(), 201));
    await client(rec).send('Database disk 90% full');
    const body = rec.bodyOf(0);
    assert.ok(!('description' in body));
    assert.ok(!('customId' in body));
    assert.ok(!('responseOptions' in body));
  });

  it('serialises response options', async () => {
    const rec = new Recorder().push(ok(alertPayload(), 201));
    await client(rec).send('Database disk 90% full', {
      responseOptions: [{ label: 'On it' }, { label: 'Seen', effect: 'PERSONAL' }],
    });
    assert.deepEqual(rec.bodyOf(0).responseOptions, [
      { label: 'On it', effect: 'SHARED' },
      { label: 'Seen', effect: 'PERSONAL' },
    ]);
  });

  it('turns a bare string into a SHARED option', async () => {
    const rec = new Recorder().push(ok(alertPayload(), 201));
    await client(rec).send('Database disk 90% full', { responseOptions: ['On it'] });
    assert.deepEqual(rec.bodyOf(0).responseOptions, [{ label: 'On it', effect: 'SHARED' }]);
  });

  it('treats a deduplicated send with zero delivery as success', async () => {
    // delivered=0 because the alert is already open and already ringing.
    const rec = new Recorder().push(
      ok(alertPayload({ delivered: 0, deduplicated: true, message: 'already open' }), 200),
    );
    const alert = await client(rec).send('Database disk 90% full', { customId: 'disk-full' });
    assert.equal(alert.deduplicated, true);
    assert.equal(alert.actuallyReachedSomeone, true);
  });

  it('throws M91DeliveryError when nobody was reached', async () => {
    const rec = new Recorder().push(ok(alertPayload({ delivered: 0, noDevice: 2, pending: 1 }), 201));
    await assert.rejects(client(rec).send('Database disk 90% full'), (error: unknown) => {
      assert.ok(error instanceof M91DeliveryError);
      assert.equal(error.delivered, 0);
      assert.equal(error.noDevice, 2);
      assert.equal(error.pending, 1);
      return true;
    });
  });

  it('can be told to tolerate zero delivery', async () => {
    const rec = new Recorder().push(ok(alertPayload({ delivered: 0 }), 201));
    const alert = await client(rec, { throwOnZeroDelivery: false }).send('Database disk 90% full');
    assert.equal(alert.delivered, 0);
  });

  it('treats a reopen as a real delivery, not a dedup', async () => {
    // One alert per (channel, customId) forever, so a repeat after a close
    // reopens that row rather than making a second. It wakes people again,
    // which is exactly what a dedup does not.
    const rec = new Recorder().push(ok(alertPayload({ delivered: 3, reopened: true }), 201));
    const alert = await client(rec).send('Shopify sync is failing', { customId: 'shopify-down' });
    assert.equal(alert.reopened, true);
    assert.equal(alert.deduplicated, false);
    assert.equal(alert.delivered, 3);
  });

  it('maps 409 to M91ChannelEmptyError with the unregistered numbers', async () => {
    const rec = new Recorder().push(
      err('CHANNEL_EMPTY', 'nobody can receive', 409, { unregistered: ['919876543210'] }),
    );
    await assert.rejects(client(rec).send('Database disk 90% full'), (error: unknown) => {
      assert.ok(error instanceof M91ChannelEmptyError);
      assert.deepEqual(error.unregistered, ['919876543210']);
      return true;
    });
  });

  it('retries a 429 exactly once, at the delay the server asked for', async () => {
    const rec = new Recorder().push(
      err('RATE_LIMITED', 'too many', 429, undefined, { 'retry-after': '60' }),
      err('RATE_LIMITED', 'too many', 429, undefined, { 'retry-after': '60' }),
    );
    await assert.rejects(client(rec).send('Database disk 90% full'), (error: unknown) => {
      assert.ok(error instanceof M91RateLimitError);
      assert.equal(error.retryAfter, 60);
      return true;
    });
    assert.deepEqual(rec.slept, [60_000]);
    assert.equal(rec.calls.length, 2);
  });

  it('succeeds when the rate limit clears on the retry', async () => {
    const rec = new Recorder().push(
      err('RATE_LIMITED', 'too many', 429, undefined, { 'retry-after': '1' }),
      ok(alertPayload(), 201),
    );
    assert.equal((await client(rec).send('Database disk 90% full')).delivered, 4);
    assert.deepEqual(rec.slept, [1000]);
  });

  it('backs off on 5xx then gives up', async () => {
    const rec = new Recorder().push(...[0, 1, 2, 3].map(() => err('INTERNAL_ERROR', 'boom', 500)));
    await assert.rejects(client(rec).send('Database disk 90% full'), M91ServerError);
    assert.deepEqual(rec.slept, [1000, 2000, 4000]);
    assert.equal(rec.calls.length, 4);
  });

  it('never retries a 400', async () => {
    const rec = new Recorder().push(err('VALIDATION_ERROR', 'Unknown field: titel', 400));
    await assert.rejects(client(rec).send('Database disk 90% full'), M91ValidationError);
    assert.equal(rec.calls.length, 1);
  });

  it('never retries a network failure, and never leaks the token', async () => {
    // A send that timed out may already have raised the alert. Retrying it
    // blindly is how one condition wakes a team four times.
    const rec = new Recorder();
    const c = new M91Client(SEND_LINK, { fetchImpl: unreachableFetch(rec), sleepImpl: rec.sleep });
    await assert.rejects(c.send('Database disk 90% full'), (error: unknown) => {
      assert.ok(error instanceof M91NetworkError);
      assert.ok(!error.message.includes('tok_test123'));
      return true;
    });
    assert.equal(rec.calls.length, 1);
  });

  it('rejects a short title before any request', async () => {
    const rec = new Recorder();
    await assert.rejects(client(rec).send('Down'), /at least 5/);
    assert.equal(rec.calls.length, 0);
  });

  it('rejects a long title before any request', async () => {
    const rec = new Recorder();
    await assert.rejects(client(rec).send('x'.repeat(2001)), /2000/);
    assert.equal(rec.calls.length, 0);
  });

  it('rejects more than twenty response options before any request', async () => {
    const rec = new Recorder();
    const options = Array.from({ length: 21 }, (_, i) => `Option ${i}`);
    await assert.rejects(
      client(rec).send('Database disk 90% full', { responseOptions: options }),
      /more than 20/,
    );
    assert.equal(rec.calls.length, 0);
  });

  it('rejects duplicate labels before any request', async () => {
    const rec = new Recorder();
    await assert.rejects(
      client(rec).send('Database disk 90% full', { responseOptions: ['On it', 'ON IT'] }),
      /repeat/,
    );
  });

  it('rejects a label over 24 characters before any request', async () => {
    const rec = new Recorder();
    await assert.rejects(
      client(rec).send('Database disk 90% full', { responseOptions: ['x'.repeat(25)] }),
      /24 characters/,
    );
  });

  it('rejects a customId over 200 characters before any request', async () => {
    const rec = new Recorder();
    await assert.rejects(
      client(rec).send('Database disk 90% full', { customId: 'x'.repeat(201) }),
      /200 characters/,
    );
  });

  it('rejects an unknown severity before any request', async () => {
    const rec = new Recorder();
    await assert.rejects(
      client(rec).send('Database disk 90% full', { severity: 'URGENT' as never }),
      /severity must be one of/,
    );
  });
});

describe('close', () => {
  it('closes by customId', async () => {
    const rec = new Recorder().push(ok({ _id: 'a1', status: 'RESOLVED' }));
    assert.equal(await client(rec).close({ customId: 'disk-full' }), true);
    assert.equal(rec.last.url, `${SEND_LINK}/close`);
    assert.deepEqual(rec.last.body, { customId: 'disk-full' });
  });

  it('closes by alertId', async () => {
    const rec = new Recorder().push(ok({ _id: 'a1', status: 'RESOLVED' }));
    await client(rec).close({ alertId: '68c0a1f2e4b09c3d5f8a0001' });
    assert.deepEqual(rec.last.body, { alertId: '68c0a1f2e4b09c3d5f8a0001' });
  });

  it('treats 404 as success', async () => {
    // Nothing to close is the state the caller asked for.
    const rec = new Recorder().push(err('NOT_FOUND', 'alert_not_found', 404));
    assert.equal(await client(rec).close({ customId: 'disk-full' }), true);
  });

  it('treats 403 as success', async () => {
    const rec = new Recorder().push(err('FORBIDDEN', 'Close failed', 403));
    assert.equal(await client(rec).close({ customId: 'disk-full' }), true);
  });

  it('rejects neither identifier', async () => {
    const rec = new Recorder();
    await assert.rejects(client(rec).close({}), /neither/);
    assert.equal(rec.calls.length, 0);
  });

  it('rejects both identifiers', async () => {
    const rec = new Recorder();
    await assert.rejects(client(rec).close({ customId: 'a', alertId: 'b' }), /both/);
  });
});

describe('getAlert', () => {
  it('returns the detail', async () => {
    const rec = new Recorder().push(ok(detailPayload()));
    const detail = await client(rec).getAlert('deploy-approval');
    assert.equal(detail?.title, 'Approve deploy to prod?');
    assert.equal(detail?.isDecided, false);
    assert.equal(rec.last.url, `${SEND_LINK}/alerts/deploy-approval`);
  });

  it('encodes the id', async () => {
    const rec = new Recorder().push(ok(detailPayload()));
    await client(rec).getAlert('deploy/approval prod');
    assert.ok(rec.last.url.endsWith('/alerts/deploy%2Fapproval%20prod'));
  });

  it('returns null on 404', async () => {
    const rec = new Recorder().push(err('NOT_FOUND', 'alert_not_found', 404));
    assert.equal(await client(rec).getAlert('nope'), null);
  });

  it('parses a decision', async () => {
    const rec = new Recorder().push(
      ok(detailPayload({ decision: { label: 'Approve', effect: 'SHARED', by: 'usr_opaque_001' } })),
    );
    const detail = await client(rec).getAlert('deploy-approval');
    assert.equal(detail?.isDecided, true);
    assert.equal(detail?.decision?.by, 'usr_opaque_001');
  });

  it('does not treat a PERSONAL response as a decision', async () => {
    // "Seen" must never read as "Approved". The server leaves decision null.
    const rec = new Recorder().push(
      ok(detailPayload({ responses: [{ label: 'Seen', effect: 'PERSONAL' }] })),
    );
    const detail = await client(rec).getAlert('deploy-approval');
    assert.equal(detail?.responses.length, 1);
    assert.equal(detail?.decision, null);
    assert.equal(detail?.isDecided, false);
  });
});

describe('waitForDecision', () => {
  it('returns the decision on a later poll', async () => {
    const rec = new Recorder().push(
      ok(detailPayload()),
      ok(detailPayload()),
      ok(detailPayload({ decision: { label: 'Approve', effect: 'SHARED' } })),
    );
    const decision = await client(rec).waitForDecision('deploy-approval', { timeoutMs: 60_000 });
    assert.equal(decision?.label, 'Approve');
    assert.equal(rec.calls.length, 3);
  });

  it('returns null on timeout', async () => {
    const rec = new Recorder().push(ok(detailPayload()));
    assert.equal(await client(rec).waitForDecision('deploy-approval', { timeoutMs: 0 }), null);
  });

  it('can throw on timeout instead', async () => {
    const rec = new Recorder().push(ok(detailPayload()));
    await assert.rejects(
      client(rec).waitForDecision('deploy-approval', { timeoutMs: 0, throwOnTimeout: true }),
      M91TimeoutError,
    );
  });

  it('stops when the alert is closed with nobody having claimed it', async () => {
    // Closed by a monitor that saw the problem heal. No answer is coming.
    const rec = new Recorder().push(ok(detailPayload({ status: 'RESOLVED', resolvedAt: 't' })));
    assert.equal(await client(rec).waitForDecision('deploy-approval', { timeoutMs: 60_000 }), null);
    assert.equal(rec.calls.length, 1);
  });

  it('keeps waiting while the alert is not visible yet', async () => {
    // A send answers before the fan-out finishes, so an immediate read can
    // outrun it. "Not there yet" is not "gone".
    const rec = new Recorder().push(
      err('NOT_FOUND', 'alert_not_found', 404),
      ok(detailPayload({ decision: { label: 'Approve', effect: 'SHARED' } })),
    );
    const decision = await client(rec).waitForDecision('deploy-approval', { timeoutMs: 60_000 });
    assert.equal(decision?.label, 'Approve');
  });

  it('clamps a poll interval below two seconds', async () => {
    const rec = new Recorder().push(
      ok(detailPayload()),
      ok(detailPayload({ decision: { label: 'Approve' } })),
    );
    await client(rec).waitForDecision('deploy-approval', {
      timeoutMs: 60_000,
      pollIntervalMs: 100,
    });
    assert.deepEqual(rec.slept, [2000]);
  });
});

describe('requestApproval', () => {
  const approvedRun = () =>
    new Recorder().push(
      ok(alertPayload(), 201),
      ok(detailPayload({ decision: { label: 'Approve', effect: 'SHARED' } })),
      ok({ _id: 'a1', status: 'RESOLVED' }),
    );

  it('returns true when approved', async () => {
    const rec = approvedRun();
    assert.equal(
      await client(rec).requestApproval('Refund 48,000 on ORD-40122?', { customId: 'refund-1' }),
      true,
    );
  });

  it('returns false when rejected', async () => {
    const rec = new Recorder().push(
      ok(alertPayload(), 201),
      ok(detailPayload({ decision: { label: 'Reject', effect: 'SHARED' } })),
      ok({ _id: 'a1', status: 'RESOLVED' }),
    );
    assert.equal(
      await client(rec).requestApproval('Refund 48,000 on ORD-40122?', { customId: 'refund-1' }),
      false,
    );
  });

  it('defaults to HIGH severity and two SHARED options', async () => {
    const rec = approvedRun();
    await client(rec).requestApproval('Refund 48,000 on ORD-40122?', { customId: 'refund-1' });
    const body = rec.bodyOf(0);
    // Something is waiting on the answer, so a call after 45s of silence is the
    // point rather than an escalation.
    assert.equal(body.severity, 'HIGH');
    assert.equal(body.isAutoClose, false);
    assert.deepEqual(body.responseOptions, [
      { label: 'Approve', effect: 'SHARED' },
      { label: 'Reject', effect: 'SHARED' },
    ]);
  });

  it('honours custom labels', async () => {
    const rec = new Recorder().push(
      ok(alertPayload(), 201),
      ok(detailPayload({ decision: { label: 'Process Refund', effect: 'SHARED' } })),
      ok({ _id: 'a1', status: 'RESOLVED' }),
    );
    assert.equal(
      await client(rec).requestApproval('Refund 48,000?', {
        customId: 'refund-1',
        approveLabel: 'Process Refund',
        rejectLabel: 'Hold Refund',
      }),
      true,
    );
  });

  it('matches the approval label case-insensitively', async () => {
    const rec = new Recorder().push(
      ok(alertPayload(), 201),
      ok(detailPayload({ decision: { label: 'approve', effect: 'SHARED' } })),
      ok({ _id: 'a1', status: 'RESOLVED' }),
    );
    assert.equal(await client(rec).requestApproval('Refund 48,000?', { customId: 'r' }), true);
  });

  it('does not treat a null decision label as approval', async () => {
    const rec = new Recorder().push(
      ok(alertPayload(), 201),
      ok(detailPayload({ decision: { label: null, effect: 'SHARED' } })),
      ok({ _id: 'a1', status: 'RESOLVED' }),
    );
    assert.equal(await client(rec).requestApproval('Refund 48,000?', { customId: 'r' }), false);
  });

  it('treats a timeout as a rejection and closes the alert', async () => {
    const rec = new Recorder().push(
      ok(alertPayload(), 201),
      ok(detailPayload()),
      ok({ _id: 'a1', status: 'RESOLVED' }),
    );
    assert.equal(
      await client(rec).requestApproval('Refund 48,000?', { customId: 'refund-1', timeoutMs: 0 }),
      false,
    );
    assert.equal(rec.last.url, `${SEND_LINK}/close`);
    assert.deepEqual(rec.last.body, { customId: 'refund-1' });
  });

  it('can throw on timeout, and still closes the alert', async () => {
    const rec = new Recorder().push(
      ok(alertPayload(), 201),
      ok(detailPayload()),
      ok({ _id: 'a1', status: 'RESOLVED' }),
    );
    await assert.rejects(
      client(rec).requestApproval('Refund 48,000?', {
        customId: 'refund-1',
        timeoutMs: 0,
        timeoutMeansReject: false,
      }),
      M91TimeoutError,
    );
    assert.equal(rec.last.url, `${SEND_LINK}/close`);
  });

  it('closes nothing when the send itself failed', async () => {
    const rec = new Recorder().push(err('CHANNEL_EMPTY', 'nobody can receive', 409));
    await assert.rejects(
      client(rec).requestApproval('Refund 48,000?', { customId: 'refund-1' }),
      M91ChannelEmptyError,
    );
    assert.equal(rec.calls.length, 1);
  });
});
