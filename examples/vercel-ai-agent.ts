/**
 * An agent on the Vercel AI SDK that asks before it deletes anything.
 */

import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs } from 'ai';

import { M91Client } from 'm91';
import { createM91AlertTool, createM91ApprovalTool } from 'm91/integrations/vercel-ai';

const client = new M91Client(process.env.M91_SEND_LINK!);

const { text } = await generateText({
  model: openai('gpt-4o'),
  system:
    'You are an operations agent. Before anything irreversible — deleting customer ' +
    'data, moving money, deploying to production — you must call m91_request_approval ' +
    'and wait. Give it a title naming the action and its target, a description with ' +
    'everything the person needs to decide, and a customId derived from what is being ' +
    'decided (never a timestamp). Proceed only on exactly "approved". ' +
    'Use m91_send_alert, which does not wait, to report something that has already ' +
    'gone wrong and needs somebody now.',
  tools: {
    m91_request_approval: await createM91ApprovalTool(client),
    m91_send_alert: await createM91AlertTool(client),
    // ...your own tools
  },
  stopWhen: stepCountIs(10),
  prompt:
    'Account acct_8821 has asked to be deleted under GDPR. Verify the request and, ' +
    'if it is valid, delete the account.',
});

console.log(text);
