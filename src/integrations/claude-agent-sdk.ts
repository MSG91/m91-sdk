/**
 * Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`): M91 as the permission
 * prompt, and M91 as tools.
 *
 * **Permission prompt.** `createM91CanUseTool` is a `canUseTool` callback: the
 * tools you name ring a phone and run only if a person approves. Everything
 * else is allowed through untouched.
 *
 * ```ts
 * import { query } from '@anthropic-ai/claude-agent-sdk';
 * import { M91Client } from '@msg91comm/m91';
 * import { createM91CanUseTool } from '@msg91comm/m91/integrations/claude-agent-sdk';
 *
 * const client = new M91Client(process.env.M91_SEND_LINK!);
 *
 * for await (const message of query({
 *   prompt: 'Clean up the stale feature branches and deploy main.',
 *   options: { canUseTool: createM91CanUseTool(client, { tools: ['Bash', 'Write'] }) },
 * })) {
 *   if (message.type === 'result') console.log(message);
 * }
 * ```
 *
 * `canUseTool` only runs when the SDK would otherwise ask. To gate a tool
 * whatever the permission mode (including `bypassPermissions`), use the
 * `PreToolUse` hook from `createM91PreToolUseHook` instead.
 *
 * **Tools.** `createM91McpServer` exposes `m91_request_approval` and
 * `m91_send_alert` as an in-process MCP server, for when the agent itself
 * should decide to ask or to wake somebody.
 */

import type {
  CanUseTool,
  HookCallbackMatcher,
  McpSdkServerConfigWithInstance,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

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

/** Tool names, or a predicate. Required: an agent that rings for every `Read` gets muted. */
type ClaudeGateOptions = GateOptions & { tools: NonNullable<GateOptions['tools']> };

/**
 * A `canUseTool` callback that asks a person on their phone before the tools
 * in `options.tools` run.
 */
export function createM91CanUseTool(client: M91Client, options: ClaudeGateOptions): CanUseTool {
  return async (toolName, input, { toolUseID }): Promise<PermissionResult> => {
    if (!(await needsHuman(options, toolName, input))) {
      return { behavior: 'allow', updatedInput: input };
    }
    const decision = await decideToolCall(client, { toolName, input, callId: toolUseID }, options);
    return decision.approved
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: decision.reason };
  };
}

/**
 * A `PreToolUse` hook matcher that asks a person before the tools in
 * `options.tools` run, in every permission mode. Pass it as
 * `options.hooks.PreToolUse`.
 *
 * ```ts
 * query({ prompt, options: { hooks: { PreToolUse: createM91PreToolUseHook(client, { tools: ['Bash'] }) } } })
 * ```
 */
export function createM91PreToolUseHook(
  client: M91Client,
  options: ClaudeGateOptions & { timeoutSeconds?: number },
): HookCallbackMatcher[] {
  return [
    {
      // The hook must outlive the wait for a human, or the SDK gives up first.
      timeout: (options.timeoutSeconds ?? 300) + 60,
      hooks: [
        async (input) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          if (!(await needsHuman(options, input.tool_name, input.tool_input))) return {};
          const decision = await decideToolCall(
            client,
            { toolName: input.tool_name, input: input.tool_input, callId: input.tool_use_id },
            options,
          );
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: decision.approved ? 'allow' : 'deny',
              permissionDecisionReason: decision.reason,
            },
          };
        },
      ],
    },
  ];
}

interface ClaudeSdkModule {
  tool: (name: string, description: string, shape: unknown, handler: unknown) => unknown;
  createSdkMcpServer: (options: { name: string; version?: string; tools: unknown[] }) => unknown;
}

async function claudeSdk(): Promise<ClaudeSdkModule> {
  try {
    const specifier = '@anthropic-ai/claude-agent-sdk';
    return (await import(specifier)) as unknown as ClaudeSdkModule;
  } catch (error) {
    throw new Error(
      'The Claude Agent SDK integration needs @anthropic-ai/claude-agent-sdk. Install it with: ' +
        'npm install @anthropic-ai/claude-agent-sdk',
      { cause: error },
    );
  }
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

/**
 * `m91_request_approval` and `m91_send_alert` as an in-process MCP server.
 * Register it under `mcpServers.m91`; the tools appear to Claude as
 * `mcp__m91__m91_request_approval` and `mcp__m91__m91_send_alert`.
 */
export async function createM91McpServer(
  client: M91Client,
  defaults: ApprovalDefaults & AlertDefaults = {},
): Promise<McpSdkServerConfigWithInstance> {
  const { tool, createSdkMcpServer } = await claudeSdk();
  const z = await loadZod('Claude Agent SDK');
  return createSdkMcpServer({
    name: 'm91',
    tools: [
      tool(APPROVAL_TOOL_NAME, APPROVAL_DESCRIPTION, approvalShape(z), async (args: ApprovalArgs) =>
        text(await runApproval(client, args, defaults)),
      ),
      tool(ALERT_TOOL_NAME, ALERT_DESCRIPTION, alertShape(z), async (args: AlertArgs) =>
        text(await runAlert(client, args, defaults)),
      ),
    ],
  }) as McpSdkServerConfigWithInstance;
}
