/**
 * Google Agent Development Kit for TypeScript (`@google/adk`): M91 as a
 * before-tool gate, and M91 as tools.
 *
 * **Gate.** `createM91BeforeToolCallback` goes in an `LlmAgent`'s
 * `beforeToolCallback`. Calls to the tools you name ring a phone first; if the
 * person rejects (or does not answer), the tool does not run and the agent
 * gets the reason back as the tool's result.
 *
 * ```ts
 * import { LlmAgent } from '@google/adk';
 * import { M91Client } from '@msg91comm/m91';
 * import { createM91BeforeToolCallback, createM91Tools } from '@msg91comm/m91/integrations/google-adk';
 *
 * const client = new M91Client(process.env.M91_SEND_LINK!);
 *
 * const agent = new LlmAgent({
 *   name: 'support_agent',
 *   model: 'gemini-2.5-flash',
 *   instruction: 'Resolve refund requests.',
 *   tools: [issueRefund, ...(await createM91Tools(client))],
 *   beforeToolCallback: createM91BeforeToolCallback(client, { tools: ['issue_refund'] }),
 * });
 * ```
 *
 * The gate waits for the answer in-process. For approvals that take hours,
 * use ADK's own Tool Confirmation and resume the session when M91's answer
 * arrives.
 */

import type { BaseTool, FunctionTool, SingleBeforeToolCallback } from '@google/adk';

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

/**
 * A `beforeToolCallback` that asks a person on their phone before the tools
 * in `options.tools` run. Returning a result object skips the tool, which is
 * how a rejection reaches the model.
 */
export function createM91BeforeToolCallback(
  client: M91Client,
  options: GateOptions & { tools: NonNullable<GateOptions['tools']> },
): SingleBeforeToolCallback {
  return async ({ tool, args, context }) => {
    const toolName = tool.name;
    if (!(await needsHuman(options, toolName, args))) return undefined;
    const callId = context.functionCallId ?? `${context.invocationId}-${toolName}`;
    const decision = await decideToolCall(client, { toolName, input: args, callId }, options);
    if (decision.approved) return undefined;
    return { status: 'rejected', error: decision.reason };
  };
}

interface AdkModule {
  FunctionTool: new (options: unknown) => FunctionTool<any>;
}

async function adkModule(): Promise<AdkModule> {
  try {
    const specifier = '@google/adk';
    return (await import(specifier)) as unknown as AdkModule;
  } catch (error) {
    throw new Error(
      'The Google ADK integration needs @google/adk. Install it with: npm install @google/adk',
      { cause: error },
    );
  }
}

/** The blocking approval tool, `m91_request_approval`, as an ADK `FunctionTool`. */
export async function createM91ApprovalTool(
  client: M91Client,
  defaults: ApprovalDefaults = {},
): Promise<BaseTool> {
  const { FunctionTool } = await adkModule();
  const z = await loadZod('Google ADK');
  return new FunctionTool({
    name: APPROVAL_TOOL_NAME,
    description: APPROVAL_DESCRIPTION,
    parameters: z.object(approvalShape(z)),
    execute: async (args: ApprovalArgs) => ({ result: await runApproval(client, args, defaults) }),
  });
}

/** The fire-and-forget alert tool, `m91_send_alert`, as an ADK `FunctionTool`. */
export async function createM91AlertTool(
  client: M91Client,
  defaults: AlertDefaults = {},
): Promise<BaseTool> {
  const { FunctionTool } = await adkModule();
  const z = await loadZod('Google ADK');
  return new FunctionTool({
    name: ALERT_TOOL_NAME,
    description: ALERT_DESCRIPTION,
    parameters: z.object(alertShape(z)),
    execute: async (args: AlertArgs) => ({ result: await runAlert(client, args, defaults) }),
  });
}

/** Both tools, for an agent's `tools` array. */
export async function createM91Tools(
  client: M91Client,
  defaults: ApprovalDefaults & AlertDefaults = {},
): Promise<BaseTool[]> {
  return [await createM91ApprovalTool(client, defaults), await createM91AlertTool(client, defaults)];
}
