/**
 * Vercel AI SDK tools.
 *
 * ```ts
 * import { M91Client } from 'm91';
 * import { createM91ApprovalTool, createM91AlertTool } from 'm91/integrations/vercel-ai';
 *
 * const client = new M91Client(process.env.M91_SEND_LINK!);
 *
 * const { text } = await generateText({
 *   model: openai('gpt-4o'),
 *   tools: {
 *     m91_request_approval: await createM91ApprovalTool(client),
 *     m91_send_alert: await createM91AlertTool(client),
 *   },
 *   maxSteps: 10,
 *   prompt: 'Look into order ORD-40122 and refund it if it checks out.',
 * });
 * ```
 *
 * The factories are **async** because `ai` is an optional peer dependency,
 * imported only when one of these is called — `npm install m91` stays at zero
 * dependencies.
 */

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
): Promise<unknown> {
  const { tool, jsonSchema } = await aiModule();
  return tool({
    description: APPROVAL_DESCRIPTION,
    // JSON Schema rather than zod, so this adapter adds no dependency of its own
    // and the argument docs stay in one file shared with every other framework.
    inputSchema: jsonSchema(APPROVAL_SCHEMA),
    execute: (args: ApprovalArgs) => runApproval(client, args, defaults),
  });
}

/** The fire-and-forget alert. Returns `"sent:delivered=N"` or `"error: …"`. */
export async function createM91AlertTool(
  client: M91Client,
  defaults: AlertDefaults = {},
): Promise<unknown> {
  const { tool, jsonSchema } = await aiModule();
  return tool({
    description: ALERT_DESCRIPTION,
    inputSchema: jsonSchema(ALERT_SCHEMA),
    execute: (args: AlertArgs) => runAlert(client, args, defaults),
  });
}

/** Both, keyed by tool name, ready to spread into `tools: {…}`. */
export async function createM91Tools(
  client: M91Client,
  defaults: ApprovalDefaults & AlertDefaults = {},
): Promise<Record<string, unknown>> {
  return {
    m91_request_approval: await createM91ApprovalTool(client, defaults),
    m91_send_alert: await createM91AlertTool(client, defaults),
  };
}
