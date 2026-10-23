/**
 * An OpenAI Agents SDK agent whose refunds need a person's approval, by phone.
 *
 *   M91_SEND_LINK=... OPENAI_API_KEY=... npx tsx examples/openai-agents.ts
 */

import { Agent, tool } from '@openai/agents';
import { z } from 'zod';

import { M91Client } from '@msg91comm/m91';
import { runWithM91Approvals } from '@msg91comm/m91/integrations/openai-agents';

const client = new M91Client(process.env.M91_SEND_LINK!);

const issueRefund = tool({
  name: 'issue_refund',
  description: 'Refund an order to the original payment method.',
  parameters: z.object({ orderId: z.string(), amountInr: z.number() }),
  // The SDK pauses here; runWithM91Approvals rings a phone and resumes.
  needsApproval: true,
  execute: async ({ orderId, amountInr }) => `Refunded ${amountInr} INR on ${orderId}.`,
});

const agent = new Agent({
  name: 'Support',
  instructions: 'Resolve refund requests. If a refund is not approved, tell the customer why.',
  tools: [issueRefund],
});

const result = await runWithM91Approvals(agent, 'Order ORD-40122 never arrived. Refund 4,800 INR.', client, {
  timeoutSeconds: 600,
});
console.log(result.finalOutput);
