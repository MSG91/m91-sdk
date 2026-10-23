/**
 * The tool definitions, written once and adapted per framework.
 *
 * A tool's name, its description and its argument docs are the entire interface
 * a model has to M91 — they are the prompt. Four adapters each spelling their
 * own copy is four descriptions that drift, and the drift is invisible until an
 * agent on one framework behaves differently from the same agent on another.
 *
 * Every adapter therefore imports the schema and the `run` from here and does
 * nothing but wrap it in the shape its framework expects.
 */

import type { M91Client } from '../client.js';
import { M91Error } from '../exceptions.js';
import { redact } from '../http.js';
import type { AlertResponse, Severity } from '../models.js';

export const APPROVED = 'approved';
export const REJECTED = 'rejected';

/**
 * `error: …` — never `approved`, whatever went wrong.
 *
 * The message is redacted: an M91 error can carry the URL it failed on, and
 * that URL has the send token in its path. A tool result goes straight into a
 * model's context and from there into logs, traces and evals.
 */
export function errorResult(error: unknown): string {
  if (error instanceof M91Error) return `error: [${error.code}] ${redact(error.message)}`;
  const message = error instanceof Error ? error.message : String(error);
  return `error: ${redact(message) || 'unknown failure'}`;
}

/**
 * `sent:delivered=N` — plus a word when nobody was actually reached.
 *
 * A model that reads "sent" and stops has no way to know the channel's phones
 * were all stale. Saying so in the result is the only channel back to it.
 */
export function alertResult(alert: AlertResponse): string {
  if (alert.deduplicated) {
    return (
      'sent:delivered=0 (an alert with this customId is already open and already ringing — ' +
      'nobody was disturbed a second time)'
    );
  }
  if (alert.delivered === 0) {
    return (
      `sent:delivered=0 WARNING: the alert was filed but no phone could be reached ` +
      `(unregistered=${alert.unregistered.length}, noDevice=${alert.noDevice}, ` +
      `pending=${alert.pending}). Nobody has been woken.`
    );
  }
  return `sent:delivered=${alert.delivered}`;
}

const SEVERITY_DOC =
  'LOW, MEDIUM, HIGH or CRITICAL. All of them ring through Do Not Disturb; HIGH and ' +
  'CRITICAL also place a voice call after 45 seconds of silence.';

const CUSTOM_ID_DOC =
  'A stable id for this exact request, derived from what is being decided ' +
  "('refund-ORD-40122'). NEVER a timestamp, a UUID or a counter: the id is what " +
  'deduplicates a retry and what closes the alert afterwards.';

/** JSON Schema rather than zod, so nothing here needs a dependency to exist. */
export const APPROVAL_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description:
        'The question, as the person reads it at 3am on a lock screen. Name the action ' +
        "and its consequence: 'Refund 48,000 on ORD-40122?' — not 'approve action'. " +
        '5-2000 characters.',
    },
    customId: { type: 'string', description: CUSTOM_ID_DOC },
    description: {
      type: 'string',
      description:
        'The context the person needs to answer without asking you anything back: what ' +
        'you found, what you are about to do, and what happens if they say no.',
    },
    severity: {
      type: 'string',
      enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      description: `${SEVERITY_DOC} An approval that blocks you is normally HIGH.`,
    },
    approveLabel: { type: 'string', description: 'The yes button, 24 characters or fewer.' },
    rejectLabel: { type: 'string', description: 'The no button, 24 characters or fewer.' },
    timeoutSeconds: {
      type: 'number',
      description: 'How long to wait for an answer before giving up. Default 300.',
    },
  },
  required: ['title', 'customId'],
  additionalProperties: false,
} as const;

export const ALERT_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'What happened, in one line somebody can act on. 5-2000 characters.',
    },
    customId: {
      type: 'string',
      description:
        "A stable id for the CONDITION, not this occurrence — 'disk-full-node7'. Repeats " +
        'while it is still open wake nobody a second time. Never a timestamp.',
    },
    description: { type: 'string', description: 'Any detail that helps them act.' },
    severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], description: SEVERITY_DOC },
  },
  required: ['title'],
  additionalProperties: false,
} as const;

export const APPROVAL_TOOL_NAME = 'm91_request_approval';
export const ALERT_TOOL_NAME = 'm91_send_alert';

export const APPROVAL_DESCRIPTION =
  'Ask a human for permission and wait for their answer. Use this BEFORE any ' +
  'irreversible or consequential action: payments, refunds, deletions, deployments, ' +
  "sending messages on someone's behalf, changing production data, or anything you " +
  'would want a colleague to sign off on. ' +
  'The person is woken on their phone immediately at full volume, through silent mode ' +
  'and Do Not Disturb, and called if they do not answer within 45 seconds. ' +
  'This call BLOCKS until they respond or the timeout passes. ' +
  "Returns 'approved' or 'rejected'. Treat anything that is not exactly 'approved' as " +
  'a refusal and do not perform the action.';

export const ALERT_DESCRIPTION =
  'Wake a human immediately about something that has already happened, without waiting ' +
  'for a reply. Use for failures, anomalies, breaches, and long jobs finishing that ' +
  'somebody is waiting on. ' +
  'The alert rings every phone on the on-call channel at full volume through silent ' +
  'mode and Do Not Disturb, and keeps ringing until somebody answers. ' +
  'Do NOT use this to ask permission — use m91_request_approval, which waits. ' +
  'Do NOT use it for anything that could wait until morning; this wakes people up. ' +
  "Returns 'sent:delivered=N', where N is how many phones were actually reached.";

export interface ApprovalArgs {
  title: string;
  customId: string;
  description?: string;
  severity?: Severity;
  approveLabel?: string;
  rejectLabel?: string;
  timeoutSeconds?: number;
}

export interface AlertArgs {
  title: string;
  customId?: string;
  description?: string;
  severity?: Severity;
}

/**
 * What a deployment wants when the model does not say.
 *
 * Set these where the tool is built, not in the prompt. How long a person has
 * to wake up, and what the buttons say, are operations decisions — a model
 * choosing its own timeout is a model deciding how long somebody has to answer.
 * It can still override per call when it has a reason.
 */
export interface ApprovalDefaults {
  severity?: Severity;
  approveLabel?: string;
  rejectLabel?: string;
  timeoutSeconds?: number;
}

export interface AlertDefaults {
  severity?: Severity;
}

/** Ask, wait, and answer in a word a model cannot misread. */
export async function runApproval(
  client: M91Client,
  args: ApprovalArgs,
  defaults: ApprovalDefaults = {},
): Promise<string> {
  try {
    const approved = await client.requestApproval(args.title, {
      customId: args.customId,
      description: args.description,
      severity: args.severity ?? defaults.severity ?? 'HIGH',
      approveLabel: args.approveLabel ?? defaults.approveLabel ?? 'Approve',
      rejectLabel: args.rejectLabel ?? defaults.rejectLabel ?? 'Reject',
      // `??`, not `||`: an explicit 0 means "do not wait", and `||` would turn
      // that into five minutes.
      timeoutMs: (args.timeoutSeconds ?? defaults.timeoutSeconds ?? 300) * 1000,
    });
    return approved ? APPROVED : REJECTED;
  } catch (error) {
    // Returned, not thrown: a thrown tool error ends the agent run, and an
    // agent that cannot ask permission should be able to say so and stop.
    return errorResult(error);
  }
}

export async function runAlert(
  client: M91Client,
  args: AlertArgs,
  defaults: AlertDefaults = {},
): Promise<string> {
  try {
    return alertResult(
      await client.send(args.title, {
        description: args.description,
        severity: args.severity ?? defaults.severity ?? 'MEDIUM',
        customId: args.customId,
      }),
    );
  } catch (error) {
    // Includes M91DeliveryError, whose message already says nobody's phone
    // rang. A model reading "error:" and retrying is right there; a model
    // reading "sent" and stopping is not.
    return errorResult(error);
  }
}

/* ------------------------------------------------------------------------ */
/* Gating a framework's own tool calls                                       */
/* ------------------------------------------------------------------------ */

/**
 * One tool call a framework is about to make, in the only three fields every
 * framework agrees on.
 */
export interface GatedCall {
  toolName: string;
  input: unknown;
  /** The framework's id for this call. Becomes the alert's customId. */
  callId: string;
}

/** How a gate decides who gets asked, and how the question reads. */
export interface GateOptions extends ApprovalDefaults {
  /**
   * Which tool calls need a human: a list of tool names, or a predicate.
   *
   * Required where a framework routes every call through the gate (Claude
   * Agent SDK, Google ADK, Vercel `toolApproval`): ringing somebody's phone
   * for every file read is how a channel gets muted.
   */
  tools?: readonly string[] | ((toolName: string, input: unknown) => boolean | Promise<boolean>);
  /** Write the lock-screen question yourself. Default: "Allow <tool>?" plus the arguments. */
  describe?: (call: GatedCall) => { title: string; description?: string };
}

export interface GateDecision {
  approved: boolean;
  /** Why, in words a model can repeat to the user. */
  reason: string;
}

/** Does this call need a human? With no `tools`, every call that reaches the gate does. */
export async function needsHuman(
  options: GateOptions,
  toolName: string,
  input: unknown,
): Promise<boolean> {
  const { tools } = options;
  if (tools === undefined) return true;
  if (typeof tools === 'function') return Boolean(await tools(toolName, input));
  return tools.includes(toolName);
}

/** A customId M91 accepts, stable across a framework's retries of the same call. */
export function gateCustomId(call: GatedCall): string {
  const raw = `tool-${call.toolName}-${call.callId}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100);
}

function defaultQuestion(call: GatedCall): { title: string; description: string } {
  let args: string;
  try {
    args = JSON.stringify(call.input, null, 2) ?? '';
  } catch {
    args = String(call.input);
  }
  if (args.length > 1500) args = `${args.slice(0, 1500)}\n… (truncated)`;
  return {
    title: `Allow the agent to run ${call.toolName}?`,
    description: `The agent wants to call ${call.toolName} with:\n${args}`,
  };
}

/**
 * Ring a phone about a tool call and wait for the answer.
 *
 * Fails closed: an M91 error, an unreachable channel or a timeout is a no,
 * with the reason spelled out, never a silent yes.
 */
export async function decideToolCall(
  client: M91Client,
  call: GatedCall,
  options: GateOptions = {},
): Promise<GateDecision> {
  const question = options.describe ? options.describe(call) : defaultQuestion(call);
  try {
    const approved = await client.requestApproval(question.title, {
      customId: gateCustomId(call),
      description: question.description,
      severity: options.severity ?? 'HIGH',
      approveLabel: options.approveLabel ?? 'Approve',
      rejectLabel: options.rejectLabel ?? 'Reject',
      timeoutMs: (options.timeoutSeconds ?? 300) * 1000,
    });
    return approved
      ? { approved: true, reason: 'Approved by a human via M91.' }
      : {
          approved: false,
          reason:
            'A human rejected this action via M91 (or did not answer in time). ' +
            'Do not retry it; tell the user it was not approved.',
        };
  } catch (error) {
    return {
      approved: false,
      reason: `Could not get human approval via M91, so the action was not run. ${errorResult(error)}`,
    };
  }
}
