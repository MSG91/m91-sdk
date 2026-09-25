/**
 * Framework adapters.
 *
 * The property under test throughout is one-directional: **nothing but an
 * explicit human approval may come back looking like an approval.** A timeout,
 * a network failure, an empty channel and a rejection must all be
 * distinguishable from a yes by a model, a graph edge, or an `if`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { M91Client } from '../src/client.js';
import { M91ChannelEmptyError, M91NetworkError } from '../src/exceptions.js';
import { M91InterruptNotifier, createM91ApprovalNode } from '../src/integrations/langgraph.js';
import {
  ALERT_SCHEMA,
  APPROVAL_SCHEMA,
  alertResult,
  errorResult,
  runAlert,
  runApproval,
} from '../src/integrations/specs.js';
import { parseAlertResponse } from '../src/models.js';
import { Recorder, SEND_LINK, alertPayload, detailPayload, err, ok } from './helpers.js';

const client = (rec: Recorder) => new M91Client(SEND_LINK, rec.options);

const approvedRun = () =>
  new Recorder().push(
    ok(alertPayload(), 201),
    ok(detailPayload({ decision: { label: 'Approve', effect: 'SHARED' } })),
    ok({ _id: 'a1', status: 'RESOLVED' }),
  );

const rejectedRun = () =>
  new Recorder().push(
    ok(alertPayload(), 201),
    ok(detailPayload({ decision: { label: 'Reject', effect: 'SHARED' } })),
    ok({ _id: 'a1', status: 'RESOLVED' }),
  );

describe('result strings', () => {
  it('never lets an error read as approved', () => {
    assert.ok(errorResult(new M91ChannelEmptyError('nobody')).startsWith('error:'));
  });

  it('redacts the send link in an error result', () => {
    // A tool result goes into a model's context, and from there into logs,
    // traces and evals.
    const text = errorResult(new M91NetworkError('failed on https://m91.msg91.com/s/tok_secret'));
    assert.ok(!text.includes('tok_secret'));
    assert.ok(text.includes('/s/***'));
  });

  it('reports the delivered count', () => {
    assert.equal(alertResult(parseAlertResponse(alertPayload({ delivered: 3 }))), 'sent:delivered=3');
  });

  it('names a dedup rather than implying failure', () => {
    const text = alertResult(parseAlertResponse(alertPayload({ delivered: 0, deduplicated: true })));
    assert.ok(text.includes('already open'));
    assert.ok(!text.includes('WARNING'));
  });

  it('warns when nobody was reached', () => {
    const text = alertResult(parseAlertResponse(alertPayload({ delivered: 0, noDevice: 2 })));
    assert.ok(text.includes('WARNING'));
    assert.ok(text.includes('Nobody has been woken'));
  });
});

describe('shared tool specs', () => {
  it('requires a title and a stable customId for an approval', () => {
    assert.deepEqual([...APPROVAL_SCHEMA.required], ['title', 'customId']);
    assert.match(APPROVAL_SCHEMA.properties.customId.description, /NEVER a timestamp/);
  });

  it('leaves customId optional on a fire-and-forget alert', () => {
    assert.deepEqual([...ALERT_SCHEMA.required], ['title']);
  });

  it('returns approved only on a real approval', async () => {
    const rec = approvedRun();
    assert.equal(
      await runApproval(client(rec), { title: 'Refund 48,000?', customId: 'refund-1' }),
      'approved',
    );
  });

  it('returns rejected on a rejection', async () => {
    const rec = rejectedRun();
    assert.equal(
      await runApproval(client(rec), { title: 'Refund 48,000?', customId: 'refund-1' }),
      'rejected',
    );
  });

  it('defaults an approval to HIGH severity', async () => {
    const rec = approvedRun();
    await runApproval(client(rec), { title: 'Refund 48,000?', customId: 'refund-1' });
    assert.equal(rec.bodyOf(0).severity, 'HIGH');
  });

  it('honours an explicit timeoutSeconds of 0 rather than defaulting it', async () => {
    // `x || 300` would turn "do not wait" into five minutes.
    const rec = new Recorder().push(
      ok(alertPayload(), 201),
      ok(detailPayload()),
      ok({ _id: 'a1', status: 'RESOLVED' }),
    );
    assert.equal(
      await runApproval(client(rec), { title: 'Refund 48,000?', customId: 'r', timeoutSeconds: 0 }),
      'rejected',
    );
    assert.equal(rec.calls.length, 3);
  });

  it('applies deployment defaults when the model stays quiet', async () => {
    // How long a person has to wake up is an operations decision, not the
    // model's.
    const rec = approvedRun();
    rec.queue[1] = ok(detailPayload({ decision: { label: 'Deploy', effect: 'SHARED' } }));
    const result = await runApproval(
      client(rec),
      { title: 'Ship api@4f21a9 to prod?', customId: 'd-1' },
      { severity: 'CRITICAL', approveLabel: 'Deploy', rejectLabel: 'Hold', timeoutSeconds: 900 },
    );
    assert.equal(result, 'approved');
    assert.equal(rec.bodyOf(0).severity, 'CRITICAL');
    const labels = (rec.bodyOf(0).responseOptions as Array<{ label: string }>).map((o) => o.label);
    assert.deepEqual(labels, ['Deploy', 'Hold']);
  });

  it('lets the model override a deployment default', async () => {
    const rec = approvedRun();
    await runApproval(
      client(rec),
      { title: 'Refund 48,000?', customId: 'r-1', severity: 'CRITICAL' },
      { severity: 'LOW' },
    );
    assert.equal(rec.bodyOf(0).severity, 'CRITICAL');
  });

  it('turns an unreachable channel into an error, not an approval', async () => {
    const rec = new Recorder().push(err('CHANNEL_EMPTY', 'nobody can receive', 409));
    const result = await runApproval(client(rec), { title: 'Refund 48,000?', customId: 'r' });
    assert.ok(result.startsWith('error:'));
  });

  it('defaults an alert to MEDIUM severity', async () => {
    const rec = new Recorder().push(ok(alertPayload(), 201));
    assert.equal(await runAlert(client(rec), { title: 'Payments API is down' }), 'sent:delivered=4');
    assert.equal(rec.bodyOf(0).severity, 'MEDIUM');
  });

  it('surfaces zero delivery on an alert as an error', async () => {
    const rec = new Recorder().push(ok(alertPayload({ delivered: 0 }), 201));
    assert.ok((await runAlert(client(rec), { title: 'Payments API is down' })).startsWith('error:'));
  });
});

describe('langgraph', () => {
  it('resolves approved', async () => {
    const rec = approvedRun();
    const notifier = new M91InterruptNotifier(client(rec));
    assert.equal(
      await notifier.notify({ title: 'Approve deploy to prod?', customId: 'deploy-abc123' }),
      'approved',
    );
  });

  it('resolves rejected', async () => {
    const rec = rejectedRun();
    const notifier = new M91InterruptNotifier(client(rec));
    assert.equal(
      await notifier.notify({ title: 'Approve deploy to prod?', customId: 'deploy-abc123' }),
      'rejected',
    );
  });

  it('resumes the graph as rejected when the pager is unreachable', async () => {
    // A graph that resumes with "approved" because the pager was down is the
    // one outcome worth ruling out by construction.
    const rec = new Recorder().push(err('UNAUTHORIZED', 'Invalid sender token', 401));
    const notifier = new M91InterruptNotifier(client(rec));
    assert.equal(await notifier.notify({ title: 'Approve deploy?', customId: 'd-1' }), 'rejected');
  });

  it('lets a per-call option beat a constructor default', async () => {
    const rec = approvedRun();
    rec.queue[1] = ok(detailPayload({ decision: { label: 'Deploy Now', effect: 'SHARED' } }));
    const notifier = new M91InterruptNotifier(client(rec), { approveLabel: 'Ship it' });
    await notifier.notify({
      title: 'Approve deploy to prod?',
      customId: 'd-1',
      approveLabel: 'Deploy Now',
    });
    const options = rec.bodyOf(0).responseOptions as Array<{ label: string }>;
    assert.deepEqual(options.map((o) => o.label), ['Deploy Now', 'Reject']);
  });

  it('runs a node that reads state and writes the decision', async () => {
    const rec = approvedRun();
    rec.queue[1] = ok(detailPayload({ decision: { label: 'Process Refund', effect: 'SHARED' } }));
    const node = createM91ApprovalNode(client(rec), { approveLabel: 'Process Refund' });
    assert.deepEqual(await node({ title: 'Approve refund of 48,000?', customId: 'refund-1' }), {
      decision: 'approved',
      approved: true,
    });
    const options = rec.bodyOf(0).responseOptions as Array<{ label: string }>;
    assert.deepEqual(options.map((o) => o.label), ['Process Refund', 'Reject']);
  });

  it('accepts question as a title', async () => {
    const rec = rejectedRun();
    const result = await createM91ApprovalNode(client(rec))({
      question: 'Approve refund?',
      customId: 'r-1',
    });
    assert.equal(result.approved, false);
  });

  it('refuses rather than inventing a customId', async () => {
    // A node that invents a customId is a node whose alerts never deduplicate
    // and never close.
    const rec = new Recorder();
    const result = await createM91ApprovalNode(client(rec))({ title: 'Approve refund of 48,000?' });
    assert.equal(result.approved, false);
    assert.equal(result.decision, 'rejected');
    assert.match(String(result.error), /customId/);
    assert.equal(rec.calls.length, 0);
  });
});
