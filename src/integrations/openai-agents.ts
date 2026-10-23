/**
 * OpenAI Agents SDK (`@openai/agents`): two tools, and M91 as the approver.
 *
 * **Approver.** Mark your risky tools `needsApproval: true`. The SDK pauses the
 * run and returns `result.interruptions`; `runWithM91Approvals` rings a phone
 * for each one, approves or rejects it on the run state with the person's
 * answer, and resumes the same run until it finishes.
 *
 * ```ts
 * import { Agent, tool } from '@openai/agents';
 * import { M91Client } from '@msg91comm/m91';
 * import { runWithM91Approvals } from '@msg91comm/m91/integrations/openai-agents';
 *
 * const issueRefund = tool({
 *   name: 'issue_refund',
 *   description: 'Refund an order.',
 *   parameters: z.object({ orderId: z.string(), amount: z.number() }),
 *   needsApproval: true,
 *   execute: async ({ orderId, amount }) => refunds.create(orderId, amount),
 * });
 *
 * const agent = new Agent({ name: 'Support', instructions: '…', tools: [issueRefund] });
 * const client = new M91Client(process.env.M91_SEND_LINK!);
 *
 * const result = await runWithM91Approvals(agent, 'Refund ORD-40122, it never arrived.', client);
 * console.log(result.finalOutput);
 * ```
 *
 * **Tools** (`createM91Tools`) are for when the model itself should decide to
 * ask, or to wake somebody about something that happened.
 *
 * `@openai/agents` is an optional peer dependency, imported only when one of
 * these is called.
 */

import type { Agent, FunctionTool, RunResult, RunState, RunToolApprovalItem } from '@openai/agents';

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
  needsHuman,
  runAlert,
  runApproval,
} from './specs.js';

interface AgentsModule {
  tool: (options: unknown) => unknown;
  run: (agent: unknown, input: unknown, options?: unknown) => Promise<unknown>;
}

async function agentsModule(): Promise<AgentsModule> {
  try {
    const specifier = '@openai/agents';
    return (await import(specifier)) as unknown as AgentsModule;
  } catch (error) {
    throw new Error(
      'The OpenAI Agents integration needs @openai/agents. Install it with: npm install @openai/agents',
      { cause: error },
    );
  }
}

/** The blocking approval tool, `m91_request_approval`. Returns `"approved"`, `"rejected"` or `"error: …"`. */
export async function createM91ApprovalTool(
  client: M91Client,
  defaults: ApprovalDefaults = {},
): Promise<FunctionTool> {
  const { tool } = await agentsModule();
  return tool({
    name: APPROVAL_TOOL_NAME,
    description: APPROVAL_DESCRIPTION,
    // JSON Schema with optional fields: the non-strict mode accepts it as is.
    parameters: APPROVAL_SCHEMA,
    strict: false,
    execute: (args: ApprovalArgs) => runApproval(client, args, defaults),
  }) as FunctionTool;
}

/** The fire-and-forget alert tool, `m91_send_alert`. Returns `"sent:delivered=N"` or `"error: …"`. */
export async function createM91AlertTool(
  client: M91Client,
  defaults: AlertDefaults = {},
): Promise<FunctionTool> {
  const { tool } = await agentsModule();
  return tool({
    name: ALERT_TOOL_NAME,
    description: ALERT_DESCRIPTION,
    parameters: ALERT_SCHEMA,
    strict: false,
    execute: (args: AlertArgs) => runAlert(client, args, defaults),
  }) as FunctionTool;
}

/** Both tools, for an agent's `tools` array. */
export async function createM91Tools(
  client: M91Client,
  defaults: ApprovalDefaults & AlertDefaults = {},
): Promise<FunctionTool[]> {
  return [await createM91ApprovalTool(client, defaults), await createM91AlertTool(client, defaults)];
}

function parseArguments(item: RunToolApprovalItem): unknown {
  const raw = item.arguments;
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function callIdOf(item: RunToolApprovalItem): string {
  const raw = item.rawItem as { callId?: string; id?: string };
  return raw.callId ?? raw.id ?? `${item.name ?? 'tool'}-${item.arguments ?? ''}`.slice(0, 60);
}

/**
 * Ask a person about every pending approval on a paused run, and record the
 * answers on its state. Returns how many were decided; resume with
 * `run(agent, result.state)`.
 *
 * Interruptions for tools outside `options.tools` are left pending for your
 * own code to decide.
 */
export async function approveInterruptionsWithM91(
  result: Pick<RunResult<any, any>, 'interruptions' | 'state'>,
  client: M91Client,
  options: GateOptions = {},
): Promise<number> {
  const state = result.state as RunState<any, any>;
  let decided = 0;
  for (const item of result.interruptions ?? []) {
    const toolName = item.name ?? 'tool';
    const input = parseArguments(item);
    if (!(await needsHuman(options, toolName, input))) continue;
    const decision = await decideToolCall(client, { toolName, input, callId: callIdOf(item) }, options);
    if (decision.approved) state.approve(item);
    else state.reject(item, { message: decision.reason });
    decided += 1;
  }
  return decided;
}

/**
 * `run()`, with every approval the run pauses for answered on a phone through
 * M91, until the run finishes or nothing left to decide is M91's.
 */
export async function runWithM91Approvals<TAgent extends Agent<any, any>>(
  agent: TAgent,
  input: string | Parameters<typeof import('@openai/agents').run>[1],
  client: M91Client,
  options: GateOptions & { runOptions?: Record<string, unknown>; maxRounds?: number } = {},
): Promise<RunResult<any, TAgent>> {
  const { run } = await agentsModule();
  const { runOptions, maxRounds = 20, ...gate } = options;
  let result = (await run(agent, input, runOptions)) as RunResult<any, TAgent>;
  for (let round = 0; round < maxRounds && (result.interruptions?.length ?? 0) > 0; round += 1) {
    if ((await approveInterruptionsWithM91(result, client, gate)) === 0) break;
    result = (await run(agent, result.state, runOptions)) as RunResult<any, TAgent>;
  }
  return result;
}
