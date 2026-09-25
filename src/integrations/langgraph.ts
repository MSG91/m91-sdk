/**
 * LangGraph helpers for the `interrupt()` pattern.
 *
 * LangGraph already knows how to stop a graph and resume it. What it has no
 * opinion about is **how the human finds out it stopped** — and the default
 * answer is that somebody notices a paused run in a web UI. At 2am, for a graph
 * that paused because it wants to move money, nobody does. M91 fills exactly
 * that gap: the graph pauses, a phone rings until somebody answers, and the
 * answer resumes the graph.
 *
 * Nothing here imports `@langchain/langgraph`. These are plain callables you use
 * *around* your graph, so they work the same with `interrupt()`, with
 * `new Command({ resume })`, or with a node you wrote by hand.
 */

import type { M91Client } from '../client.js';
import type { Severity } from '../models.js';
import { APPROVED, REJECTED } from './specs.js';

export interface NotifyOptions {
  title: string;
  customId: string;
  description?: string;
  severity?: Severity;
  approveLabel?: string;
  rejectLabel?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export type NotifyDefaults = Omit<NotifyOptions, 'title' | 'customId'>;

export type Verdict = typeof APPROVED | typeof REJECTED;

/**
 * Wake a human about an interrupted graph and return what they said.
 *
 * ```ts
 * const notifier = new M91InterruptNotifier(client);
 *
 * const result = await graph.invoke(state, config);
 * if (result.__interrupt__) {
 *   const data = result.__interrupt__[0].value;
 *   const decision = await notifier.notify({
 *     title: data.question,
 *     customId: data.customId,
 *     timeoutMs: 600_000,
 *   });
 *   await graph.invoke(new Command({ resume: decision }), config);
 * }
 * ```
 *
 * Resolves `"approved"` or `"rejected"` and **never anything else** — a failure
 * to reach anybody comes back as `"rejected"`, because a graph that resumes
 * with an ambiguous value resumes with whatever the node's `if` happens to do
 * with it.
 */
export class M91InterruptNotifier {
  private readonly client: M91Client;
  private readonly defaults: NotifyDefaults;

  constructor(client: M91Client, defaults: NotifyDefaults = {}) {
    this.client = client;
    this.defaults = defaults;
  }

  async notify(options: NotifyOptions): Promise<Verdict> {
    const { title, customId, ...rest } = options;
    const merged = { ...this.defaults, ...strip(rest) };
    try {
      const approved = await this.client.requestApproval(title, {
        customId,
        severity: 'HIGH',
        timeoutMs: 300_000,
        ...merged,
      });
      return approved ? APPROVED : REJECTED;
    } catch {
      // Nobody could be reached, so nobody approved. Resuming a graph with
      // "approved" because the pager was down is the one outcome worth ruling
      // out by construction.
      return REJECTED;
    }
  }
}

/**
 * Build a graph node that asks a human and writes the answer into state.
 *
 * ```ts
 * builder.addNode('humanApproval', createM91ApprovalNode(client, {
 *   approveLabel: 'Deploy Now',
 *   rejectLabel: 'Hold Release',
 *   timeoutMs: 600_000,
 * }));
 * ```
 *
 * The node reads `title` (or `question`) and `customId` from state and returns
 * `{ decision, approved }` for the next edge to branch on. Anything passed here
 * is a default the state can override per run.
 */
export function createM91ApprovalNode(
  client: M91Client,
  defaults: NotifyDefaults = {},
): (state: unknown) => Promise<{ decision: Verdict; approved: boolean; error?: string }> {
  const notifier = new M91InterruptNotifier(client, defaults);

  return async (state: unknown) => {
    const data = (state && typeof state === 'object' ? state : {}) as Record<string, unknown>;
    const title = data.title ?? data.question;
    const customId = data.customId ?? data.custom_id;

    if (!title || !customId) {
      // Said loudly rather than defaulted. A node that invents a customId is a
      // node whose alerts never deduplicate and never close.
      return {
        decision: REJECTED,
        approved: false,
        error:
          "error: the approval node needs 'title' (or 'question') and 'customId' in state",
      };
    }

    const decision = await notifier.notify({
      title: String(title),
      customId: String(customId),
      ...strip({
        description: data.description as string | undefined,
        severity: data.severity as Severity | undefined,
        approveLabel: data.approveLabel as string | undefined,
        rejectLabel: data.rejectLabel as string | undefined,
        timeoutMs: data.timeoutMs as number | undefined,
      }),
    });
    return { decision, approved: decision === APPROVED };
  };
}

/** Drop undefined keys so a spread cannot blank out a default with `undefined`. */
function strip<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
