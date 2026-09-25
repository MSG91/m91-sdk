/**
 * A LangChain agent that has to ask before it spends money.
 *
 * The interesting part is not the wiring — it is the system prompt. A tool the
 * model *can* call is not a tool the model *will* call, and "ask a human before
 * anything irreversible" has to be stated as a rule with a list, not implied.
 */

import { ChatAnthropic } from '@langchain/anthropic';
import { createReactAgent } from '@langchain/langgraph/prebuilt';

import { M91Client } from 'm91';
import { createM91AlertTool, createM91ApprovalTool } from 'm91/integrations/langchain';

const client = new M91Client(process.env.M91_SEND_LINK!);

const tools = [
  await createM91ApprovalTool(client), // blocks until a human answers
  await createM91AlertTool(client), // wakes somebody and carries on
  // ...your own tools: issueRefund, deploy, deleteAccount, and so on.
];

const SYSTEM = `You are an operations agent with access to production systems.

Before ANY of the following, you must call m91_request_approval and wait for the
answer:
  - moving money: refunds, payouts, charges, credits
  - deleting or overwriting anything a customer owns
  - deploying, rolling back, or changing production configuration
  - sending a message to a customer on the company's behalf

Rules for that call:
  - \`title\` is what somebody reads on a lock screen at 3am. Name the action and
    the amount or the target: "Refund 48,000 on ORD-40122?" — not "approve action".
  - \`description\` is everything they need to answer without asking you anything.
  - \`customId\` is derived from the thing being decided — the order id, the
    commit sha, the account id. Never a timestamp, never a UUID: it is what
    stops a retry raising a second alert, and what closes the alert afterwards.
  - The result is "approved" or "rejected". If it is not exactly "approved",
    do not do the thing. Say what you were going to do and stop.

Use m91_send_alert, which does not wait, when something has already gone wrong
and a human needs to know now — a failed job, a breach, a stuck queue. Do not
use it for anything that could wait until morning: it wakes people up.`;

const agent = createReactAgent({
  llm: new ChatAnthropic({ model: 'claude-sonnet-5' }),
  tools,
  prompt: SYSTEM,
});

// The agent pauses here — a phone rings, somebody taps Approve or Reject, and
// the run continues with their answer in the transcript.
const result = await agent.invoke({
  messages: [
    {
      role: 'user',
      content:
        'Customer on order ORD-40122 says their item never arrived. ' +
        'Look into it and refund them if it checks out.',
    },
  ],
});

console.log(result.messages.at(-1)?.content);
