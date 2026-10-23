/**
 * Vercel AI SDK: two tools, and a gate for your own tools.
 *
 * **Tools** the model calls when it decides to ask (`createM91Tools`).
 *
 * **Gate** (`createM91ToolApproval`) plugs into AI SDK 6+'s `toolApproval`
 * option: every call to the tools you name rings a phone first, and runs only
 * if a person approves. The model cannot skip it, because it never decides to
 * ask: the SDK asks for it.
 *
 * ```ts
 * const { text } = await generateText({
 *   model: 'openai/gpt-5-mini',
 *   tools: { issueRefund, deleteUser },
 *   toolApproval: createM91ToolApproval(client, { tools: ['issueRefund', 'deleteUser'] }),
 *   stopWhen: isStepCount(5),
 *   prompt: 'Refund order ORD-40122.',
 * });
 * ```
 *
 * ```ts
 * import { M91Client } from '@msg91comm/m91';
 * import { createM91ApprovalTool, createM91AlertTool } from '@msg91comm/m91/integrations/vercel-ai';
 *
 * const client = new M91Client(process.env.M91_SEND_LINK!);
 *
 * const { text } = await generateText({
 *   model: openai('gpt-4o'),
 *   tools: {
 *     m91_request_approval: await createM91ApprovalTool(client),
 *     m91_send_alert: await createM91AlertTool(client),
 *   },
 *   stopWhen: isStepCount(10),
 *   prompt: 'Look into order ORD-40122 and refund it if it checks out.',
 * });
 * ```
 *
 * The factories are **async** because `ai` is an optional peer dependency,
 * imported only when one of these is called — `npm install @msg91comm/m91` stays at zero
 * dependencies.
 */

import type { Tool, ToolApprovalStatus, ToolSet } from 'ai';

import type { M91Client } from '../client.js';
import {
  ALERT_DESCRIPTION,
  ALERT_SCHEMA,
  APPROVAL_DESCRIPTION,
  APPROVAL_SCHEMA,
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

interface AiModule {
  tool: (definition: unknown) => unknown;
  jsonSchema: (schema: unknown) => unknown;
}

async function aiModule(): Promise<AiModule> {
  try {
    // A variable specifier: an optional peer dependency must not be a build
    // requirement for this package.
    const specifier = 'ai';
    return (await import(specifier)) as unknown as AiModule;
  } catch (error) {
    throw new Error(
      'The Vercel AI SDK integration needs the `ai` package. Install it with: npm install ai',
      { cause: error },
    );
  }
}

/**
 * The blocking approval gate. Returns `"approved"`, `"rejected"` or
 * `"error: …"`, and nothing but a real human approval returns `"approved"`.
 */
export async function createM91ApprovalTool(
  client: M91Client,
  defaults: ApprovalDefaults = {},
): Promise<Tool<ApprovalArgs, string>> {
  const { tool, jsonSchema } = await aiModule();
  return tool({
    description: APPROVAL_DESCRIPTION,
    // JSON Schema rather than zod, so this adapter adds no dependency of its own
    // and the argument docs stay in one file shared with every other framework.
    inputSchema: jsonSchema(APPROVAL_SCHEMA),
    execute: (args: ApprovalArgs) => runApproval(client, args, defaults),
  }) as Tool<ApprovalArgs, string>;
}

/** The fire-and-forget alert. Returns `"sent:delivered=N"` or `"error: …"`. */
export async function createM91AlertTool(
  client: M91Client,
  defaults: AlertDefaults = {},
): Promise<Tool<AlertArgs, string>> {
  const { tool, jsonSchema } = await aiModule();
  return tool({
    description: ALERT_DESCRIPTION,
    inputSchema: jsonSchema(ALERT_SCHEMA),
    execute: (args: AlertArgs) => runAlert(client, args, defaults),
  }) as Tool<AlertArgs, string>;
}

/** Both, keyed by tool name, ready to spread into `tools: {…}`. */
export async function createM91Tools(
  client: M91Client,
  defaults: ApprovalDefaults & AlertDefaults = {},
): Promise<ToolSet> {
  return {
    m91_request_approval: await createM91ApprovalTool(client, defaults),
    m91_send_alert: await createM91AlertTool(client, defaults),
  };
}

/** The fields of an AI SDK tool call the gate reads. */
interface ApprovalRequestLike {
  toolCall: { toolName: string; input: unknown; toolCallId: string };
}

/**
 * A `toolApproval` function for `generateText` / `streamText` / `ToolLoopAgent`.
 *
 * Calls to the tools in `options.tools` block while M91 rings a phone, then run
 * if a person approves and come back to the model as denied otherwise. Every
 * other call is `not-applicable` and runs as normal. Not synchronous: it waits
 * up to `timeoutSeconds` (default 300) for an answer.
 */
export function createM91ToolApproval(
  client: M91Client,
  options: GateOptions & { tools: NonNullable<GateOptions['tools']> },
): (request: ApprovalRequestLike) => Promise<ToolApprovalStatus> {
  return async ({ toolCall }) => {
    if (!(await needsHuman(options, toolCall.toolName, toolCall.input))) return 'not-applicable';
    const decision = await decideToolCall(
      client,
      { toolName: toolCall.toolName, input: toolCall.input, callId: toolCall.toolCallId },
      options,
    );
    return decision.approved
      ? { type: 'approved', reason: decision.reason }
      : { type: 'denied', reason: decision.reason };
  };
}
