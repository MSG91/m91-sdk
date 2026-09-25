/** M91URLBuilder — the GET form, which is the whole point of the product. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { M91ValidationError } from '../src/exceptions.js';
import { M91URLBuilder } from '../src/url-builder.js';
import { SEND_LINK } from './helpers.js';

const builder = () => new M91URLBuilder(SEND_LINK);
const q = (url: string) => Object.fromEntries(new URL(url).searchParams.entries());

describe('construction', () => {
  it('normalises a pasted link', () => {
    assert.equal(new M91URLBuilder(`${SEND_LINK}/?title=old`).sendLink, SEND_LINK);
  });

  it('rejects a link with no token', () => {
    assert.throws(() => new M91URLBuilder('https://m91.msg91.com/s/'), M91ValidationError);
  });

  it('rejects a bare token', () => {
    assert.throws(() => new M91URLBuilder('tok_test123'), /full URL/);
  });
});

describe('testUrl', () => {
  it('is the bare link and raises nothing', () => {
    // No title means a ping. That is what stands between a pasted link and a
    // team woken by a crawler, a link preview or a mail scanner.
    const url = builder().testUrl();
    assert.equal(url, SEND_LINK);
    assert.ok(!url.includes('?'));
  });
});

describe('build', () => {
  it('carries the title', () => {
    const url = builder().build('CPU > 95% on prod-server-3');
    assert.ok(url.startsWith(`${SEND_LINK}?`));
    assert.equal(q(url).title, 'CPU > 95% on prod-server-3');
  });

  it('omits MEDIUM', () => {
    // It is the server's default, so spelling it costs length and buys nothing.
    // These get retyped by hand.
    assert.ok(!('severity' in q(builder().build('CPU > 95% on prod-3'))));
  });

  it('includes HIGH', () => {
    assert.equal(q(builder().build('CPU > 95% on prod-3', { severity: 'HIGH' })).severity, 'HIGH');
  });

  it('encodes the customId', () => {
    const url = builder().build('CPU > 95% on prod-3', { customId: 'cpu high/prod 3' });
    assert.ok(url.includes('cpu+high%2Fprod+3'));
    assert.equal(q(url).customId, 'cpu high/prod 3');
  });

  it('carries the description', () => {
    assert.equal(
      q(builder().build('CPU > 95% here', { description: 'Sustained 12 min' })).description,
      'Sustained 12 min',
    );
  });

  it('joins respond labels with the first SHARED implied', () => {
    // The shape almost every real alert has: one button that takes the job,
    // and some number of "seen" buttons that do not.
    assert.equal(q(builder().build('CPU > 95% here', { respond: ['On it', 'Escalate'] })).respond, 'On it,Escalate');
  });

  it('writes the force-SHARED marker for response options', () => {
    const url = builder().build('CPU > 95% here', {
      respond: [{ label: 'Approve' }, { label: 'Reject' }, { label: 'Seen', effect: 'PERSONAL' }],
    });
    // Approve is first, so already SHARED; Reject needs the "!" to join it.
    assert.equal(q(url).respond, 'Approve,Reject!,Seen');
  });

  it('preserves an explicit bang', () => {
    assert.equal(
      q(builder().build('CPU > 95% here', { respond: ['On it', 'Also on it!'] })).respond,
      'On it,Also on it!',
    );
  });

  it('rejects a PERSONAL first option', () => {
    assert.throws(
      () => builder().build('CPU > 95% here', { respond: [{ label: 'Seen', effect: 'PERSONAL' }] }),
      /always SHARED/,
    );
  });

  it('spells isAutoClose as true or false', () => {
    assert.equal(q(builder().build('CPU > 95% here', { isAutoClose: true })).isAutoClose, 'true');
    assert.equal(q(builder().build('CPU > 95% here', { isAutoClose: false })).isAutoClose, 'false');
  });

  it('omits isAutoClose when unset', () => {
    assert.ok(!('isAutoClose' in q(builder().build('CPU > 95% here'))));
  });

  it('rejects a short title', () => {
    assert.throws(() => builder().build('Down'), /at least 5/);
  });

  it('rejects a long title', () => {
    assert.throws(() => builder().build('x'.repeat(2001)), /2000/);
  });

  it('rejects an unknown severity', () => {
    assert.throws(() => builder().build('CPU > 95% here', { severity: 'URGENT' as never }), /severity/);
  });

  it('rejects more than six respond labels', () => {
    const respond = Array.from({ length: 7 }, (_, i) => `Option ${i}`);
    assert.throws(() => builder().build('CPU > 95% here', { respond }), /at most 6/);
  });

  it('rejects a label containing a comma', () => {
    // The comma is the separator, so this would silently become two buttons.
    assert.throws(
      () => builder().build('CPU > 95% here', { respond: ['Restart, then page Ana'] }),
      /comma/,
    );
  });

  it('rejects duplicate labels', () => {
    assert.throws(() => builder().build('CPU > 95% here', { respond: ['On it', 'ON IT'] }), /repeat/);
  });

  it('rejects a label over 24 characters', () => {
    assert.throws(() => builder().build('CPU > 95% here', { respond: ['x'.repeat(25)] }), /24 characters/);
  });
});

describe('buildMany', () => {
  it('returns one URL per spec', () => {
    const urls = builder().buildMany([
      { title: 'CPU > 95% on prod-3', severity: 'HIGH', customId: 'cpu-high-prod3' },
      { title: 'Disk > 90% on prod-3' },
    ]);
    assert.equal(urls.length, 2);
    assert.equal(q(urls[0]).severity, 'HIGH');
    assert.ok(!('severity' in q(urls[1])));
  });

  it('rejects a spec with no title', () => {
    assert.throws(
      () => builder().buildMany([{ severity: 'HIGH' } as never]),
      /at least 5|title/,
    );
  });
});
