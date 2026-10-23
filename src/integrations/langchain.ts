/**
 * LangChain tools.
 *
 * Two of them, and the split matters more than it looks:
 *
 * - the approval tool **blocks**. The agent stops until a human answers on
 *   their phone. Give it to an agent that can do something irreversible.
 * - the alert tool does not. It wakes somebody and carries on.
 *
 * ```ts
 * import { M91Client } from '@msg91comm/m91';
 * import { createM91ApprovalTool, createM91AlertTool } from '@msg91comm/m91/integrations/langchain';
 *
 * const client = new M91Client(process.env.M91_SEND_LINK!);
 * const tools = [
 *   await createM91ApprovalTool(client),
 *   await createM91AlertTool(client),
 *   ...myTools,
 * ];
 * const agent = createAgent({ model: 'openai:gpt-5-mini', tools });  // from 'langchain'
 * ```
 *
 * The factories are **async** because `@langchain/core` is an optional peer
 * dependency, imported only when one of these is called. That keeps `npm
 * install @msg91comm/m91` at zero dependencies, which matters for a package whose job is
 * to work when everything else is on fire.
 */

import type { DynamicStructuredTool } from '@langchain/core/tools';

import type { M91Client } from '../client.js';
import {
  ALERT_DESCRIPTION,
  ALERT_SCHEMA,
  ALERT_TOOL_NAME,
  APPROVAL_DESCRIPTION,
  APPROVAL_SCHEMA,
  APPROVAL_TOOL_NAME,
  type AlertArgs,
  type AlertDefaults,
  type ApprovalArgs,
  type ApprovalDefaults,
  type GateOptions,
  decideToolCall,
  runAlert,
  runApproval,
} from './specs.js';

async function langchainTool(): Promise<(fn: unknown, config: unknown) => unknown> {
  try {
    // The specifier is a variable so TypeScript does not try to resolve an
    // optional peer dependency at build time. Compiling this package must not
    // require every framework it can adapt to.
    const specifier = '@langchain/core/tools';
    const mod = (await import(specifier)) as { tool: (fn: unknown, config: unknown) => unknown };
    return mod.tool;
  } catch (error) {
    throw new Error(
      'The LangChain integration needs @langchain/core. Install it with: ' +
        'npm install @langchain/core',
      { cause: error },
    );
  }
}

/**
 * The blocking approval gate, as a LangChain tool named `m91_request_approval`.
 * Returns `"approved"`, `"rejected"` or `"error: …"` — and nothing but a real
 * human approval returns `"approved"`.
 */
export async function createM91ApprovalTool(
  client: M91Client,
  defaults: ApprovalDefaults = {},
): Promise<DynamicStructuredTool> {
  const tool = await langchainTool();
  return tool((args: ApprovalArgs) => runApproval(client, args, defaults), {
    name: APPROVAL_TOOL_NAME,
    description: APPROVAL_DESCRIPTION,
    schema: APPROVAL_SCHEMA,
  }) as DynamicStructuredTool;
}

/**
 * The fire-and-forget alert, as a LangChain tool named `m91_send_alert`.
 * Returns `"sent:delivered=N"` or `"error: …"`.
 */
export async function createM91AlertTool(
  client: M91Client,
  defaults: AlertDefaults = {},
): Promise<DynamicStructuredTool> {
  const tool = await langchainTool();
  return tool((args: AlertArgs) => runAlert(client, args, defaults), {
    name: ALERT_TOOL_NAME,
    description: ALERT_DESCRIPTION,
    schema: ALERT_SCHEMA,
  }) as DynamicStructuredTool;
}

/** Both, in the order an agent's `tools` array usually wants them. */
export async function createM91Tools(
  client: M91Client,
  defaults: ApprovalDefaults & AlertDefaults = {},
): Promise<DynamicStructuredTool[]> {
  return [
    await createM91ApprovalTool(client, defaults),
    await createM91AlertTool(client, defaults),
  ];
}

/* ------------------------------------------------------------------------ */
/* humanInTheLoopMiddleware / Deep Agents: answering the interrupt          */
/* ------------------------------------------------------------------------ */

/** One tool call the middleware paused on, as `HITLRequest.actionRequests` carries it. */
interface ActionRequestLike {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

/** The payload of the interrupt `humanInTheLoopMiddleware` (and Deep Agents' `interruptOn`) raises. */
export interface HITLRequestLike {
  actionRequests: ActionRequestLike[];
}

/** What the middleware expects back: one decision per action request, in order. */
export interface M91HITLResponse {
  decisions: Array<{ type: 'approve' } | { type: 'reject'; message: string }>;
}

function isHITLRequest(value: unknown): value is HITLRequestLike {
  return Array.isArray((value as HITLRequestLike | undefined)?.actionRequests);
}

/**
 * Ask a person about every tool call in a `HITLRequest`, one phone alert per
 * call, and build the `{ decisions }` the middleware resumes with.
 *
 * `"approved"` / `"rejected"` strings (what `M91InterruptNotifier` returns) are
 * **not** a valid resume value for the middleware; this is.
 *
 * `threadId` makes each alert's customId stable across a retry of the same
 * pause, so a retried resume does not ring twice.
 */
export async function resolveHITLWithM91(
  request: HITLRequestLike,
  client: M91Client,
  options: GateOptions & { threadId?: string } = {},
): Promise<M91HITLResponse> {
  const decisions: M91HITLResponse['decisions'] = [];
  for (const [index, action] of request.actionRequests.entries()) {
    const callId = `${options.threadId ?? 'run'}-${index}`;
    const decision = await decideToolCall(
      client,
      { toolName: action.name, input: action.args, callId },
      options,
    );
    decisions.push(decision.approved ? { type: 'approve' } : { type: 'reject', message: decision.reason });
  }
  return { decisions };
}

/** The parts of a LangChain agent / Deep Agent / compiled graph this file calls. */
export interface InvokableAgentLike {
  invoke(input: any, config?: any): Promise<any>;
}

/**
 * `agent.invoke()`, with every `humanInTheLoopMiddleware` pause answered on a
 * phone through M91 and resumed with `Command({ resume: { decisions } })`.
 * Works for `createAgent` with `humanInTheLoopMiddleware` and for Deep Agents
 * created with `interruptOn`. Needs a checkpointer and a `thread_id`.
 */
export async function invokeWithM91Approvals<TResult = any>(
  agent: InvokableAgentLike,
  input: unknown,
  config: { configurable: { thread_id: string } } & Record<string, unknown>,
  client: M91Client,
  options: GateOptions & { maxRounds?: number } = {},
): Promise<TResult> {
  const { Command } = await langgraphModule();
  const { maxRounds = 20, ...gate } = options;
  let result = await agent.invoke(input, config);
  for (let round = 0; round < maxRounds; round += 1) {
    const pending = (result?.__interrupt__ as Array<{ value: unknown }> | undefined)?.[0]?.value;
    if (!isHITLRequest(pending)) break;
    const response = await resolveHITLWithM91(pending, client, {
      ...gate,
      threadId: `${config.configurable.thread_id}-${round}`,
    });
    result = await agent.invoke(new Command({ resume: response }), config);
  }
  return result as TResult;
}

async function langgraphModule(): Promise<{ Command: new (options: { resume: unknown }) => unknown }> {
  try {
    const specifier = '@langchain/langgraph';
    return (await import(specifier)) as { Command: new (options: { resume: unknown }) => unknown };
  } catch (error) {
    throw new Error(
      'Resuming a LangChain / Deep Agents interrupt needs @langchain/langgraph. Install it with: ' +
        'npm install @langchain/langgraph',
      { cause: error },
    );
  }
}
