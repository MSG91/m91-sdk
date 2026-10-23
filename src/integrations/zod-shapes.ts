/**
 * The approval and alert arguments as zod shapes, for frameworks that only
 * take zod (Claude Agent SDK, Mastra, Google ADK).
 *
 * Built from the zod the caller already has, passed in, so this package never
 * imports zod itself and the descriptions stay the ones in `specs.ts`.
 */

import { ALERT_SCHEMA, APPROVAL_SCHEMA } from './specs.js';

/** The slice of zod this file uses; v3 and v4 both satisfy it. */
export interface ZodLike {
  string(): any;
  number(): any;
  enum(values: readonly [string, ...string[]]): any;
  object(shape: Record<string, any>): any;
}

const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export function approvalShape(z: ZodLike): Record<string, any> {
  const p = APPROVAL_SCHEMA.properties;
  return {
    title: z.string().describe(p.title.description),
    customId: z.string().describe(p.customId.description),
    description: z.string().optional().describe(p.description.description),
    severity: z.enum(SEVERITIES).optional().describe(p.severity.description),
    approveLabel: z.string().optional().describe(p.approveLabel.description),
    rejectLabel: z.string().optional().describe(p.rejectLabel.description),
    timeoutSeconds: z.number().optional().describe(p.timeoutSeconds.description),
  };
}

export function alertShape(z: ZodLike): Record<string, any> {
  const p = ALERT_SCHEMA.properties;
  return {
    title: z.string().describe(p.title.description),
    customId: z.string().optional().describe(p.customId.description),
    description: z.string().optional().describe(p.description.description),
    severity: z.enum(SEVERITIES).optional().describe(p.severity.description),
  };
}

/** zod is an optional peer dependency: import it only when asked, and say so if it is missing. */
export async function loadZod(framework: string): Promise<ZodLike> {
  try {
    const specifier = 'zod';
    const mod = (await import(specifier)) as { z?: ZodLike } & ZodLike;
    return mod.z ?? mod;
  } catch (error) {
    throw new Error(`The ${framework} integration needs zod. Install it with: npm install zod`, {
      cause: error,
    });
  }
}
