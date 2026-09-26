/** M91Platform — the API-key surface: one person, by phone number. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  M91AuthError,
  M91ForbiddenError,
  M91DeliveryError,
  M91NotFoundError,
  M91ValidationError,
} from '../src/exceptions.js';
import { M91Platform } from '../src/platform.js';
import { API_KEY, PHONE, Recorder, alertPayload, detailPayload, err, ok } from './helpers.js';

const BASE = 'https://m91.msg91.com/api/v1';
const platform = (rec: Recorder, baseUrl?: string) =>
  new M91Platform(API_KEY, { ...rec.options, ...(baseUrl ? { baseUrl } : {}) });

describe('construction', () => {
  it('requires the m91sk_ prefix', () => {
    // Server-side the prefix is what tells a key from a mobile JWT, so a key
    // without it never reaches the key verifier and comes back as a bare 401
    // that reads like revocation.
    assert.throws(() => new M91Platform('sk_live_whatever'), /m91sk_/);
  });

  it('rejects an empty key', () => {
    assert.throws(() => new M91Platform(''), M91ValidationError);
  });

  it('sends the key as a bearer header', async () => {
    const rec = new Recorder().push(ok({ phone: PHONE, state: 'pending' }, 201));
    await platform(rec).inviteRecipient(PHONE);
    assert.equal(rec.last.headers.authorization, `Bearer ${API_KEY}`);
  });

  it('shows only the key prefix when stringified', () => {
    const text = String(new M91Platform(API_KEY));
    assert.ok(!text.includes(API_KEY));
    assert.match(text, /m91sk_/);
  });

  it('trims a trailing slash from the base url', () => {
    assert.equal(
      new M91Platform(API_KEY, { baseUrl: 'https://staging.example.com/' }).baseUrl,
      'https://staging.example.com',
    );
  });
});

describe('verify', () => {
  it('names the key and its owner', async () => {
    const rec = new Recorder().push(
      ok({
        key: { _id: 'k1', prefix: 'm91sk_a1b2', label: 'Production', createdAt: 't' },
        owner: { phone: '919876543210' },
      }),
    );
    const info = await platform(rec).verify();
    assert.equal(info.prefix, 'm91sk_a1b2');
    assert.equal(info.label, 'Production');
    assert.equal(info.ownerPhone, '919876543210');
    assert.equal(rec.last.url, `${BASE}/me`);
  });

  it('alerts nobody', async () => {
    // The only route on this surface safe to call just to test a credential.
    const rec = new Recorder().push(ok({ key: { _id: 'k1' }, owner: { phone: '9' } }));
    await platform(rec).verify();
    assert.equal(rec.last.method, 'GET');
    assert.equal(rec.last.body, undefined);
  });

  it('rejects a revoked key', async () => {
    const rec = new Recorder().push(err('UNAUTHORIZED', 'This API key was revoked', 401));
    await assert.rejects(platform(rec).verify(), M91AuthError);
  });
});

describe('inviteRecipient', () => {
  it('reports a fresh invite as pending', async () => {
    const rec = new Recorder().push(ok({ phone: PHONE, state: 'pending', reachable: false }, 201));
    const recipient = await platform(rec).inviteRecipient(PHONE, 'Acme CRM');
    assert.equal(recipient.state, 'pending');
    assert.equal(recipient.reachable, false);
    assert.equal(rec.last.url, `${BASE}/recipients`);
    // The label is the name the PERSON sees on the alert — the product, not
    // the recipient. It defaults to "Direct alerts" when omitted.
    assert.deepEqual(rec.last.body, { phone: PHONE, label: 'Acme CRM' });
  });

  it('treats a repeat invite (200) as success, not an error', async () => {
    // Idempotent by design — calling it on every login is the intended use.
    const rec = new Recorder().push(ok({ phone: PHONE, state: 'accepted', reachable: true }, 200));
    assert.equal((await platform(rec).inviteRecipient(PHONE)).state, 'accepted');
  });

  it('reports declined rather than throwing', async () => {
    // Terminal. No API re-invites a declined number; only they can undo it.
    const rec = new Recorder().push(ok({ phone: PHONE, state: 'declined', reachable: false }));
    assert.equal((await platform(rec).inviteRecipient(PHONE)).state, 'declined');
  });

  it('omits the label when absent', async () => {
    const rec = new Recorder().push(ok({ phone: PHONE, state: 'pending' }, 201));
    await platform(rec).inviteRecipient(PHONE);
    assert.deepEqual(rec.last.body, { phone: PHONE });
  });
});

describe('removeRecipient', () => {
  it('removes them', async () => {
    const rec = new Recorder().push(ok({ phone: PHONE, state: 'ACCEPTED' }));
    assert.equal(await platform(rec).removeRecipient(PHONE), true);
    assert.equal(rec.last.method, 'DELETE');
    assert.equal(rec.last.url, `${BASE}/recipients/${PHONE}`);
  });

  it('treats 404 as success', async () => {
    const rec = new Recorder().push(err('NOT_FOUND', 'membership_not_found', 404));
    assert.equal(await platform(rec).removeRecipient(PHONE), true);
  });
});

describe('alertPerson', () => {
  it('sends the phone alongside the alert body', async () => {
    const rec = new Recorder().push(ok(alertPayload({ delivered: 1 }), 201));
    const alert = await platform(rec).alertPerson(PHONE, 'Your export job failed', {
      severity: 'HIGH',
    });
    assert.equal(alert.delivered, 1);
    assert.equal(rec.last.url, `${BASE}/alerts`);
    assert.equal(rec.bodyOf(0).phone, PHONE);
    assert.equal(rec.bodyOf(0).severity, 'HIGH');
  });

  it('surfaces an uninvited number as a 404, not a silent invitation', async () => {
    // An alert must never be what invites somebody: they are not an M91 user
    // yet, so the urgent thing would arrive as an ordinary message that does
    // not pierce Do Not Disturb, does not repeat and does not escalate.
    const rec = new Recorder().push(err('NOT_FOUND', 'not_a_recipient: invite this number first', 404));
    await assert.rejects(platform(rec).alertPerson(PHONE, 'Your export job failed'), M91NotFoundError);
  });

  it('throws M91DeliveryError here too when nobody was reached', async () => {
    // The guard used to live only on the send-link client, so a direct alert to
    // somebody who had reinstalled their phone answered 201 and looked exactly
    // like success. With a roster of one there is nobody else it reached.
    const rec = new Recorder().push(ok(alertPayload({ delivered: 0, noDevice: 1 }), 201));
    await assert.rejects(platform(rec).alertPerson(PHONE, 'Your export job failed'), (error: unknown) => {
      assert.ok(error instanceof M91DeliveryError);
      assert.equal(error.noDevice, 1);
      return true;
    });
  });

  it('can be told to tolerate zero delivery', async () => {
    const rec = new Recorder().push(ok(alertPayload({ delivered: 0 }), 201));
    const p = new M91Platform(API_KEY, { ...rec.options, throwOnZeroDelivery: false });
    assert.equal((await p.alertPerson(PHONE, 'Your export job failed')).delivered, 0);
  });

  it('treats a deduplicated direct alert as success', async () => {
    const rec = new Recorder().push(ok(alertPayload({ delivered: 0, deduplicated: true }), 200));
    const alert = await platform(rec).alertPerson(PHONE, 'Your export job failed', {
      customId: 'x',
    });
    assert.equal(alert.actuallyReachedSomeone, true);
  });

  it('validates the alert before any request', async () => {
    const rec = new Recorder();
    await assert.rejects(platform(rec).alertPerson(PHONE, 'Bad'), /at least 5/);
    assert.equal(rec.calls.length, 0);
  });
});

describe('getAlert', () => {
  it('passes the phone as a query parameter', async () => {
    const rec = new Recorder().push(ok(detailPayload()));
    const detail = await platform(rec).getAlert('export-fail-priya', PHONE);
    assert.equal(detail?.title, 'Approve deploy to prod?');
    assert.equal(rec.last.url, `${BASE}/alerts/export-fail-priya?phone=${PHONE}`);
  });

  it('returns null on 404', async () => {
    const rec = new Recorder().push(err('NOT_FOUND', 'alert_not_found', 404));
    assert.equal(await platform(rec).getAlert('nope', PHONE), null);
  });
});

describe('closeAlert', () => {
  it('closes by customId', async () => {
    const rec = new Recorder().push(ok({ _id: 'a1', status: 'RESOLVED' }));
    assert.equal(await platform(rec).closeAlert(PHONE, { customId: 'export-fail' }), true);
    assert.equal(rec.last.url, `${BASE}/alerts/close`);
    assert.deepEqual(rec.last.body, { phone: PHONE, customId: 'export-fail' });
  });

  it('treats 404 as success', async () => {
    const rec = new Recorder().push(err('NOT_FOUND', 'alert_not_found', 404));
    assert.equal(await platform(rec).closeAlert(PHONE, { customId: 'gone' }), true);
  });

  it('treats 403 already_resolved as success', async () => {
    // Found in production: closing an already-closed alert answers 403
    // already_resolved, and this path used to let it escape while
    // M91Client.close() swallowed it. Two clients, one contract.
    const rec = new Recorder().push(err('FORBIDDEN', 'already_resolved', 403));
    assert.equal(await platform(rec).closeAlert(PHONE, { customId: 'x' }), true);
  });

  it('does NOT swallow a 403 on remove', async () => {
    // Deliberately not symmetric: there, 403 means the channel is not yours.
    const rec = new Recorder().push(err('FORBIDDEN', 'not your channel', 403));
    await assert.rejects(platform(rec).removeMember('ch1', PHONE), M91ForbiddenError);
  });

  it('rejects neither identifier', async () => {
    await assert.rejects(platform(new Recorder()).closeAlert(PHONE, {}), /neither/);
  });
});

describe('createChannel', () => {
  it('returns the send link', async () => {
    const rec = new Recorder().push(
      ok({ _id: 'ch1', name: 'SRE On-Call', sendLink: 'https://m91.msg91.com/s/tok_new' }, 201),
    );
    const channel = await platform(rec).createChannel('SRE On-Call');
    assert.equal(channel.id, 'ch1');
    assert.equal(channel.sendLink, 'https://m91.msg91.com/s/tok_new');
    assert.deepEqual(rec.last.body, { name: 'SRE On-Call', alertOwner: true });
  });

  it('passes alertOwner: false through', async () => {
    const rec = new Recorder().push(ok({ _id: 'ch1', name: 'Acme', sendLink: 's' }, 201));
    await platform(rec).createChannel('Acme', false);
    assert.equal(rec.bodyOf(0).alertOwner, false);
  });

  it('tolerates a null send link', async () => {
    // The link comes from the owner's accepted sender row; it can be absent.
    const rec = new Recorder().push(ok({ _id: 'ch1', name: 'Acme', sendLink: null }, 201));
    assert.equal((await platform(rec).createChannel('Acme')).sendLink, null);
  });

  it('rejects a name over 80 characters before any request', async () => {
    const rec = new Recorder();
    await assert.rejects(platform(rec).createChannel('x'.repeat(81)), /80 characters/);
    assert.equal(rec.calls.length, 0);
  });

  it('rejects an empty name', async () => {
    await assert.rejects(platform(new Recorder()).createChannel('   '), M91ValidationError);
  });
});

describe('addMembers', () => {
  it('returns the four buckets', async () => {
    const rec = new Recorder().push(
      ok({ invited: [PHONE], already: [], pending: [], declined: ['919000000000'] }),
    );
    const result = await platform(rec).addMembers('ch1', [PHONE, '919000000000']);
    assert.deepEqual(result.invited, [PHONE]);
    assert.deepEqual(result.declined, ['919000000000']);
    assert.equal(rec.last.url, `${BASE}/channels/ch1/members`);
  });

  it('rejects more than 500 before any request', async () => {
    const rec = new Recorder();
    const phones = Array.from({ length: 501 }, (_, i) => `9198765${String(i).padStart(5, '0')}`);
    await assert.rejects(platform(rec).addMembers('ch1', phones), /more than 500/);
    assert.equal(rec.calls.length, 0);
  });

  it('rejects an empty list', async () => {
    await assert.rejects(platform(new Recorder()).addMembers('ch1', []), M91ValidationError);
  });
});

describe('removeMember', () => {
  it('removes them', async () => {
    const rec = new Recorder().push(ok({ phone: PHONE, state: 'ACCEPTED' }));
    assert.equal(await platform(rec).removeMember('ch1', PHONE), true);
    assert.equal(rec.last.url, `${BASE}/channels/ch1/members/${PHONE}`);
  });

  it('treats 404 as success', async () => {
    const rec = new Recorder().push(err('NOT_FOUND', 'membership_not_found', 404));
    assert.equal(await platform(rec).removeMember('ch1', PHONE), true);
  });
});

describe('phone validation', () => {
  for (const bad of ['+919876543210', '91 9876 543210', '9198765', '9'.repeat(16), '91987654321a', '']) {
    it(`rejects ${JSON.stringify(bad)}`, async () => {
      const rec = new Recorder();
      await assert.rejects(platform(rec).inviteRecipient(bad), M91ValidationError);
      assert.equal(rec.calls.length, 0);
    });
  }

  it('gives the leading + its own message', async () => {
    // The one everybody gets wrong.
    await assert.rejects(platform(new Recorder()).inviteRecipient('+919876543210'), /must not start with/);
  });

  for (const good of ['919876543210', '12025550123', '44712345678']) {
    it(`accepts ${good}`, async () => {
      const rec = new Recorder().push(ok({ phone: good, state: 'pending' }, 201));
      assert.equal((await platform(rec).inviteRecipient(good)).phone, good);
    });
  }

  it('trims surrounding whitespace', async () => {
    const rec = new Recorder().push(ok({ phone: PHONE, state: 'pending' }, 201));
    await platform(rec).inviteRecipient(`  ${PHONE}  `);
    assert.equal(rec.bodyOf(0).phone, PHONE);
  });
});
