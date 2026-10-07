/**
 * The parts of the API the SDK could not reach.
 *
 * Same three gaps as the Python suite: a sender could not attach anything, a
 * responder's note and files were `unknown` inside `responses`, and there was
 * no way to list the channels an API key owns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAlertPayload, parseAlertDetail } from '../src/models.js';
import { M91ValidationError } from '../src/exceptions.js';

test('send can carry attachment urls', () => {
  const payload = buildAlertPayload('Disk full', { attachments: ['https://x/a.png'] });
  assert.deepEqual(payload.attachments, ['https://x/a.png']);
});

test('attachments must be https', () => {
  assert.throws(
    () => buildAlertPayload('Disk full', { attachments: ['http://insecure/a.png'] }),
    M91ValidationError,
  );
});

test('nothing attached means the field is omitted — the schema is strict', () => {
  assert.equal('attachments' in buildAlertPayload('Disk full'), false);
  assert.equal('attachments' in buildAlertPayload('Disk full', { attachments: [] }), false);
});

test('callbackUrl rides along', () => {
  assert.equal(buildAlertPayload('Disk full', { callbackUrl: 'https://x/cb' }).callbackUrl, 'https://x/cb');
});

test('a response exposes its note and files', () => {
  const detail = parseAlertDetail({
    _id: '1',
    status: 'OPEN',
    severity: 'HIGH',
    pending: 2,
    attachments: ['https://x/sender.pdf'],
    responses: [
      {
        label: 'Approve',
        effect: 'SHARED',
        optionIndex: 0,
        note: 'ran it twice, looks fine',
        attachments: [{ url: 'https://x/p.jpg', name: 'p.jpg', type: 'image/jpeg', size: 1024 }],
      },
    ],
  });
  assert.equal(detail.responses[0].note, 'ran it twice, looks fine');
  assert.deepEqual(detail.responses[0].attachments[0], {
    url: 'https://x/p.jpg', name: 'p.jpg', type: 'image/jpeg', size: 1024,
  });
  // A sender's are bare strings on the wire, the same shape here.
  assert.deepEqual(detail.attachments, [{ url: 'https://x/sender.pdf', name: null, type: null, size: null }]);
  assert.equal(detail.pending, 2);
});

test('an alert with nothing attached parses to empty, not undefined', () => {
  const detail = parseAlertDetail({ _id: '1', status: 'OPEN', severity: 'LOW' });
  assert.deepEqual(detail.attachments, []);
  assert.deepEqual(detail.responses, []);
  assert.equal(detail.pending, 0);
});

test('an option can require a note or a file', () => {
  const payload = buildAlertPayload('Disk is full', {
    responseOptions: [{ label: 'Fixed it', effect: 'SHARED', required: ['attachment'], optional: ['note'] }],
  });
  assert.deepEqual(payload.responseOptions, [
    { label: 'Fixed it', effect: 'SHARED', required: ['attachment'], optional: ['note'] },
  ]);
});

test('an option that asks for nothing omits both keys', () => {
  const payload = buildAlertPayload('Disk is full', { responseOptions: ['Seen'] });
  assert.deepEqual(payload.responseOptions, [{ label: 'Seen', effect: 'SHARED' }]);
});

test('only note and attachment can be collected', () => {
  assert.throws(
    () => buildAlertPayload('Disk is full', { responseOptions: [{ label: 'x', required: ['selfie'] as never }] }),
    M91ValidationError,
  );
});

test('a field cannot be both required and optional', () => {
  assert.throws(
    () => buildAlertPayload('Disk is full', {
      responseOptions: [{ label: 'x', required: ['note'], optional: ['note'] }],
    }),
    M91ValidationError,
  );
});

test('other is tri-state — undefined leaves the server default alone', () => {
  assert.equal('other' in buildAlertPayload('Disk is full'), false);
  assert.equal(buildAlertPayload('Disk is full', { other: false }).other, false);
  assert.equal(buildAlertPayload('Disk is full', { other: true }).other, true);
});
