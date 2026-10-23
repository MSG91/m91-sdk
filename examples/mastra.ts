/**
 * A Mastra agent whose refunds need a person's approval, by phone.
 *
 *   M91_SEND_LINK=... OPENAI_API_KEY=... npx tsx examples/mastra.ts
 */

import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { M91Client } from '@msg91comm/m91';
import { generateWithM91Approvals } from '@msg91comm/m91/integrations/mastra';

const client = new M91Client(process.env.M91_SEND_LINK!);

const issueRefund = createTool({
  id: 'issue-refund',
  description: 'Refund an order to the original payment method.',
  inputSchema: z.object({ orderId: z.string(), amountInr: z.number() }),
  requireApproval: true,
  execute: async ({ orderId, amountInr }) => ({ status: 'refunded', orderId, amountInr }),
});

const support = new Agent({
  id: 'support',
  name: 'Support',
  instructions: 'Resolve refund requests. If a refund is declined, tell the customer why.',
  model: 'openai/gpt-5-mini',
  tools: { issueRefund },
});

// Suspended runs live in Mastra's storage: add a storage provider here in production.
const mastra = new Mastra({ agents: { support } });

const output = await generateWithM91Approvals(
  mastra.getAgent('support'),
  'Order ORD-40122 never arrived. Refund 4,800 INR.',
  client,
);
console.log(output.text);
