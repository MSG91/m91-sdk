/**
 * Gating a framework's own tool calls.
 *
 * Same one-directional property as the tools: only an explicit human approval
 * may let a gated call run. A rejection, a timeout and an M91 failure all
 * block it, and calls outside the gate are never delayed by a phone.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { M91Client } from '../src/client.js';
import {
  createM91CanUseTool,
  createM91PreToolUseHook,
} from '../src/integrations/claude-agent-sdk.js';
import { createM91BeforeToolCallback } from '../src/integrations/google-adk.js';
import { generateWithM91Approvals, type MastraOutputLike } from '../src/integrations/mastra.js';
import { approveInterruptionsWithM91 } from '../src/integrations/openai-agents.js';
import { decideToolCall, gateCustomId, needsHuman } from '../src/integrations/specs.js';
import { createM91ToolApproval } from '../src/integrations/vercel-ai.js';
import { Recorder, SEND_LINK, alertPayload, detailPayload, err, ok } from './helpers.js';

const client = (rec: Recorder) => new M91Client(SEND_LINK, rec.options);

const answered = (label: 'Approve' | 'Reject') =>
  new Recorder().push(
    ok(alertPayload(), 201),
    ok(detailPayload({ decision: { label, effect: 'SHARED' } })),
    ok({ _id: 'a1', status: 'RESOLVED' }),
  );

const call = { toolName: 'issue_refund', input: { orderId: 'ORD-1', amount: 4800 }, callId: 'call_1' };

describe('decideToolCall', () => {
  it('approves only on an explicit approval', async () => {
    assert.equal((await decideToolCall(client(answered('Approve')), call)).approved, true);
    assert.equal((await decideToolCall(client(answered('Reject')), call)).approved, false);
  });

  it('fails closed when M91 cannot be reached', async () => {
    const rec = new Recorder().push(err('CHANNEL_EMPTY', 'nobody can receive', 409));
    const decision = await decideToolCall(client(rec), call);
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /error:/);
  });

  it('asks about the tool and its arguments, under a stable customId', async () => {
    const rec = answered('Approve');
    await decideToolCall(client(rec), call);
    const body = rec.bodyOf(0);
    assert.equal(body.customId, 'tool-issue_refund-call_1');
    assert.match(String(body.title), /issue_refund/);
    assert.match(String(body.description), /ORD-1/);
  });
});

describe('needsHuman and gateCustomId', () => {
  it('gates everything with no list, only listed names with one', async () => {
    assert.equal(await needsHuman({}, 'Read', {}), true);
    assert.equal(await needsHuman({ tools: ['Bash'] }, 'Read', {}), false);
    assert.equal(await needsHuman({ tools: ['Bash'] }, 'Bash', {}), true);
    assert.equal(await needsHuman({ tools: (name) => name.startsWith('delete') }, 'deleteUser', {}), true);
  });

  it('keeps customIds to safe characters', () => {
    assert.equal(gateCustomId({ toolName: 'mcp__x/y', input: {}, callId: 'a b:c' }), 'tool-mcp__x-y-a-b-c');
  });
});

describe('Vercel AI SDK toolApproval', () => {
  it('does not ring for tools outside the list', async () => {
    const approval = createM91ToolApproval(client(new Recorder()), { tools: ['issue_refund'] });
    const status = await approval({ toolCall: { toolName: 'lookup', input: {}, toolCallId: 't1' } });
    assert.equal(status, 'not-applicable');
  });

  it('turns a rejection into denied', async () => {
    const approval = createM91ToolApproval(client(answered('Reject')), { tools: ['issue_refund'] });
    const status = await approval({ toolCall: { toolName: 'issue_refund', input: {}, toolCallId: 't1' } });
    assert.equal(typeof status === 'object' && status?.type, 'denied');
  });

  it('turns an approval into approved', async () => {
    const approval = createM91ToolApproval(client(answered('Approve')), { tools: ['issue_refund'] });
    const status = await approval({ toolCall: { toolName: 'issue_refund', input: {}, toolCallId: 't1' } });
    assert.equal(typeof status === 'object' && status?.type, 'approved');
  });
});

describe('Claude Agent SDK', () => {
  const opts = { signal: new AbortController().signal, toolUseID: 'toolu_1' } as never;

  it('lets ungated tools through without a phone', async () => {
    const canUseTool = createM91CanUseTool(client(new Recorder()), { tools: ['Bash'] });
    const result = await canUseTool('Read', { file_path: 'a.ts' }, opts);
    assert.equal(result?.behavior, 'allow');
  });

  it('denies a gated tool the person rejected', async () => {
    const canUseTool = createM91CanUseTool(client(answered('Reject')), { tools: ['Bash'] });
    const result = await canUseTool('Bash', { command: 'rm -rf build' }, opts);
    assert.equal(result?.behavior, 'deny');
  });

  it('answers PreToolUse with deny on a rejection', async () => {
    const [matcher] = createM91PreToolUseHook(client(answered('Reject')), { tools: ['Bash'] });
    const out = (await matcher!.hooks[0]!(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'deploy' },
        tool_use_id: 'toolu_2',
      } as never,
      'toolu_2',
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
  });
});

describe('Google ADK beforeToolCallback', () => {
  const context = { functionCallId: 'fc_1', invocationId: 'inv_1' } as never;
  const tool = (name: string) => ({ name }) as never;

  it('skips the tool with a reason when rejected', async () => {
    const before = createM91BeforeToolCallback(client(answered('Reject')), { tools: ['issue_refund'] });
    const out = await before({ tool: tool('issue_refund'), args: {}, context });
    assert.equal(out?.status, 'rejected');
  });

  it('runs the tool when approved', async () => {
    const before = createM91BeforeToolCallback(client(answered('Approve')), { tools: ['issue_refund'] });
    assert.equal(await before({ tool: tool('issue_refund'), args: {}, context }), undefined);
  });
});

describe('OpenAI Agents interruptions', () => {
  it('approves and rejects on the run state from the answers', async () => {
    const decisions: string[] = [];
    const state = {
      approve: () => decisions.push('approve'),
      reject: (_: unknown, o?: { message?: string }) => decisions.push(`reject:${Boolean(o?.message)}`),
    };
    const item = (callId: string) =>
      ({ name: 'issue_refund', arguments: '{"orderId":"ORD-1"}', rawItem: { callId } }) as never;

    const rec = answered('Approve');
    rec.push(
      ok(alertPayload(), 201),
      ok(detailPayload({ decision: { label: 'Reject', effect: 'SHARED' } })),
      ok({ _id: 'a1', status: 'RESOLVED' }),
    );
    const decided = await approveInterruptionsWithM91(
      { interruptions: [item('c1'), item('c2')], state: state as never },
      client(rec),
    );
    assert.equal(decided, 2);
    assert.deepEqual(decisions, ['approve', 'reject:true']);
  });
});

describe('Mastra suspended approvals', () => {
  it('approves through the agent and returns the finished output', async () => {
    const calls: string[] = [];
    const suspended: MastraOutputLike = {
      text: '',
      finishReason: 'suspended',
      runId: 'run_1',
      suspendPayload: { toolCallId: 'tc_1', toolName: 'issue-refund', args: { orderId: 'ORD-1' } },
    };
    const agent = {
      generate: async () => suspended,
      approveToolCallGenerate: async () => (calls.push('approve'), { text: 'refunded', finishReason: 'stop' }),
      declineToolCallGenerate: async () => (calls.push('decline'), { text: 'declined', finishReason: 'stop' }),
    };
    const output = await generateWithM91Approvals(agent, 'refund it', client(answered('Approve')));
    assert.equal(output.text, 'refunded');
    assert.deepEqual(calls, ['approve']);
  });
});

describe('LangChain humanInTheLoopMiddleware / Deep Agents', () => {
  it('builds one decision per action request, in order', async () => {
    const { resolveHITLWithM91 } = await import('../src/integrations/langchain.js');
    const rec = answered('Approve');
    rec.push(
      ok(alertPayload(), 201),
      ok(detailPayload({ decision: { label: 'Reject', effect: 'SHARED' } })),
      ok({ _id: 'a1', status: 'RESOLVED' }),
    );
    const response = await resolveHITLWithM91(
      {
        actionRequests: [
          { name: 'write_file', args: { path: 'a.md' } },
          { name: 'execute', args: { command: 'rm -rf /' } },
        ],
      },
      client(rec),
      { threadId: 't1' },
    );
    assert.deepEqual(
      response.decisions.map((d) => d.type),
      ['approve', 'reject'],
    );
  });

  it('resumes the agent with a Command carrying the decisions', async () => {
    const { invokeWithM91Approvals } = await import('../src/integrations/langchain.js');
    const inputs: unknown[] = [];
    const agent = {
      invoke: async (input: unknown) => {
        inputs.push(input);
        return inputs.length === 1
          ? { __interrupt__: [{ value: { actionRequests: [{ name: 'write_file', args: {} }] } }] }
          : { messages: ['done'] };
      },
    };
    const result = await invokeWithM91Approvals(
      agent,
      { messages: [] },
      { configurable: { thread_id: 'th' } },
      client(answered('Approve')),
    );
    assert.deepEqual(result, { messages: ['done'] });
    const resume = (inputs[1] as { resume?: { decisions: Array<{ type: string }> } }).resume;
    assert.equal(resume?.decisions[0]?.type, 'approve');
  });
});
