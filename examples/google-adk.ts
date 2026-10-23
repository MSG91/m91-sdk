/**
 * A Google ADK agent whose refunds ring a phone before they run.
 *
 *   M91_SEND_LINK=... GOOGLE_GENAI_API_KEY=... npx tsx examples/google-adk.ts
 */

import { FunctionTool, InMemoryRunner, LlmAgent } from '@google/adk';
import { z } from 'zod';

import { M91Client } from '@msg91comm/m91';
import { createM91BeforeToolCallback } from '@msg91comm/m91/integrations/google-adk';

const client = new M91Client(process.env.M91_SEND_LINK!);

const issueRefund = new FunctionTool({
  name: 'issue_refund',
  description: 'Refund an order to the original payment method.',
  parameters: z.object({ orderId: z.string(), amountInr: z.number() }),
  execute: async ({ orderId, amountInr }) => ({ status: 'refunded', orderId, amountInr }),
});

const agent = new LlmAgent({
  name: 'support_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Resolve refund requests. If a refund is rejected, tell the customer why.',
  tools: [issueRefund],
  beforeToolCallback: createM91BeforeToolCallback(client, { tools: ['issue_refund'] }),
});

const runner = new InMemoryRunner({ agent, appName: 'm91-example' });
const session = await runner.sessionService.createSession({ appName: 'm91-example', userId: 'u1' });
for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: session.id,
  newMessage: { role: 'user', parts: [{ text: 'Order ORD-40122 never arrived. Refund 4,800 INR.' }] },
})) {
  const text = event.content?.parts?.map((p) => p.text ?? '').join('');
  if (text) console.log(text);
}
