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
 * const agent = createReactAgent({ llm, tools });
 * ```
 *
 * The factories are **async** because `@langchain/core` is an optional peer
 * dependency, imported only when one of these is called. That keeps `npm
 * install m91` at zero dependencies, which matters for a package whose job is
 * to work when everything else is on fire.
 */

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
): Promise<unknown> {
  const tool = await langchainTool();
  return tool((args: ApprovalArgs) => runApproval(client, args, defaults), {
    name: APPROVAL_TOOL_NAME,
    description: APPROVAL_DESCRIPTION,
    schema: APPROVAL_SCHEMA,
  });
}

/**
 * The fire-and-forget alert, as a LangChain tool named `m91_send_alert`.
 * Returns `"sent:delivered=N"` or `"error: …"`.
 */
export async function createM91AlertTool(
  client: M91Client,
  defaults: AlertDefaults = {},
): Promise<unknown> {
  const tool = await langchainTool();
  return tool((args: AlertArgs) => runAlert(client, args, defaults), {
    name: ALERT_TOOL_NAME,
    description: ALERT_DESCRIPTION,
    schema: ALERT_SCHEMA,
  });
}

/** Both, in the order an agent's `tools` array usually wants them. */
export async function createM91Tools(
  client: M91Client,
  defaults: ApprovalDefaults & AlertDefaults = {},
): Promise<unknown[]> {
  return [
    await createM91ApprovalTool(client, defaults),
    await createM91AlertTool(client, defaults),
  ];
}
