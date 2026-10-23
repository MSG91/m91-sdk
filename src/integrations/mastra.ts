/**
 * Mastra (`@mastra/core`): M91 as the approver for `requireApproval` tools,
 * and M91 as tools.
 *
 * **Approver.** Mark your risky tools `requireApproval: true`. Mastra suspends
 * the run when the agent calls one; `generateWithM91Approvals` rings a phone
 * for each suspended call and approves or declines it with the person's
 * answer until the run finishes.
 *
 * ```ts
 * import { Agent } from '@mastra/core/agent';
 * import { createTool } from '@mastra/core/tools';
 * import { M91Client } from '@msg91comm/m91';
 * import { generateWithM91Approvals } from '@msg91comm/m91/integrations/mastra';
 *
 * const issueRefund = createTool({
 *   id: 'issue-refund',
 *   description: 'Refund an order.',
 *   inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
 *   requireApproval: true,
 *   execute: async ({ orderId, amount }) => refunds.create(orderId, amount),
 * });
 *
 * const agent = new Agent({ id: 'support', name: 'Support', instructions: '…',
 *   model: 'openai/gpt-5-mini', tools: { issueRefund } });
 * const client = new M91Client(process.env.M91_SEND_LINK!);
 *
 * const output = await generateWithM91Approvals(agent, 'Refund ORD-40122.', client);
 * console.log(output.text);
 * ```
 *
 * Mastra keeps suspended runs in its storage, so configure a storage provider
 * on your `Mastra` instance for approvals to resume.
 */

import type { Tool } from '@mastra/core/tools';

import type { M91Client } from '../client.js';
import {
  ALERT_DESCRIPTION,
  ALERT_TOOL_NAME,
  APPROVAL_DESCRIPTION,
  APPROVAL_TOOL_NAME,
  type AlertArgs,
  type AlertDefaults,
  type ApprovalArgs,
  type ApprovalDefaults,
  type GateOptions,
  decideToolCall,
  needsHuman,
  runAlert,
  runApproval,
} from './specs.js';
import { alertShape, approvalShape, loadZod } from './zod-shapes.js';

/** The parts of a Mastra `generate()` result this file reads. */
export interface MastraOutputLike {
  text: string;
  finishReason?: unknown;
  runId?: string;
  suspendPayload?: unknown;
}

/** The parts of a Mastra `Agent` this file calls. */
export interface MastraAgentLike<TOutput extends MastraOutputLike = MastraOutputLike> {
  generate(prompt: any, options?: any): Promise<TOutput>;
  approveToolCallGenerate(options: { runId: string; toolCallId?: string }): Promise<TOutput>;
  declineToolCallGenerate(options: {
    runId: string;
    toolCallId?: string;
    reason?: string;
  }): Promise<TOutput>;
}

interface PendingApproval {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

function pendingApproval(output: MastraOutputLike): PendingApproval | null {
  if (output.finishReason !== 'suspended' || !output.runId) return null;
  const payload = output.suspendPayload as Partial<PendingApproval> | undefined;
  if (!payload?.toolCallId || !payload.toolName) return null;
  return { toolCallId: payload.toolCallId, toolName: payload.toolName, args: payload.args };
}

/**
 * `agent.generate()`, with every tool approval the run suspends for answered
 * on a phone through M91. Approvals for tools outside `options.tools` are
 * returned still suspended, for your own code.
 */
export async function generateWithM91Approvals<TOutput extends MastraOutputLike>(
  agent: MastraAgentLike<TOutput>,
  prompt: unknown,
  client: M91Client,
  options: GateOptions & { generateOptions?: Record<string, unknown>; maxRounds?: number } = {},
): Promise<TOutput> {
  const { generateOptions, maxRounds = 20, ...gate } = options;
  let output = await agent.generate(prompt, generateOptions);
  for (let round = 0; round < maxRounds; round += 1) {
    const pending = pendingApproval(output);
    if (!pending || !(await needsHuman(gate, pending.toolName, pending.args))) break;
    const runId = output.runId as string;
    const decision = await decideToolCall(
      client,
      { toolName: pending.toolName, input: pending.args, callId: pending.toolCallId },
      gate,
    );
    output = decision.approved
      ? await agent.approveToolCallGenerate({ runId, toolCallId: pending.toolCallId })
      : await agent.declineToolCallGenerate({
          runId,
          toolCallId: pending.toolCallId,
          reason: decision.reason,
        });
  }
  return output;
}

interface MastraToolsModule {
  createTool: (options: unknown) => unknown;
}

async function mastraTools(): Promise<MastraToolsModule> {
  try {
    const specifier = '@mastra/core/tools';
    return (await import(specifier)) as unknown as MastraToolsModule;
  } catch (error) {
    throw new Error('The Mastra integration needs @mastra/core. Install it with: npm install @mastra/core', {
      cause: error,
    });
  }
}

/** A Mastra tool, typed loosely enough to drop into any agent's `tools`. */
export type M91MastraTool = Tool<any, any, any, any, any, string, any>;

/** The blocking approval tool, `m91_request_approval`, as a Mastra tool. */
export async function createM91ApprovalTool(
  client: M91Client,
  defaults: ApprovalDefaults = {},
): Promise<M91MastraTool> {
  const { createTool } = await mastraTools();
  const z = await loadZod('Mastra');
  return createTool({
    id: APPROVAL_TOOL_NAME,
    description: APPROVAL_DESCRIPTION,
    inputSchema: z.object(approvalShape(z)),
    execute: async (args: ApprovalArgs) => ({ result: await runApproval(client, args, defaults) }),
  }) as M91MastraTool;
}

/** The fire-and-forget alert tool, `m91_send_alert`, as a Mastra tool. */
export async function createM91AlertTool(
  client: M91Client,
  defaults: AlertDefaults = {},
): Promise<M91MastraTool> {
  const { createTool } = await mastraTools();
  const z = await loadZod('Mastra');
  return createTool({
    id: ALERT_TOOL_NAME,
    description: ALERT_DESCRIPTION,
    inputSchema: z.object(alertShape(z)),
    execute: async (args: AlertArgs) => ({ result: await runAlert(client, args, defaults) }),
  }) as M91MastraTool;
}

/** Both tools, keyed for an `Agent`'s `tools` object. */
export async function createM91Tools(
  client: M91Client,
  defaults: ApprovalDefaults & AlertDefaults = {},
): Promise<Record<string, M91MastraTool>> {
  return {
    [APPROVAL_TOOL_NAME]: await createM91ApprovalTool(client, defaults),
    [ALERT_TOOL_NAME]: await createM91AlertTool(client, defaults),
  };
}
