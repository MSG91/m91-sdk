/**
 * A Deep Agent that can plan and research on its own, but rings a phone before
 * it writes files or runs shell commands.
 *
 *   M91_SEND_LINK=... ANTHROPIC_API_KEY=... npx tsx examples/deep-agents.ts
 */

import { MemorySaver } from '@langchain/langgraph';
import { createDeepAgent } from 'deepagents';

import { M91Client } from '@msg91comm/m91';
import { invokeWithM91Approvals } from '@msg91comm/m91/integrations/langchain';

const client = new M91Client(process.env.M91_SEND_LINK!);

const agent = createDeepAgent({
  model: 'anthropic:claude-sonnet-4-5',
  systemPrompt: 'You are a release engineer.',
  // These tools pause the run; invokeWithM91Approvals rings a phone for each.
  interruptOn: { write_file: true, edit_file: true, execute: true },
  checkpointer: new MemorySaver(),
});

const result = await invokeWithM91Approvals(
  agent,
  { messages: [{ role: 'user', content: 'Write the release notes for v2.4 to RELEASE.md.' }] },
  { configurable: { thread_id: 'release-v2.4' } },
  client,
  { timeoutSeconds: 600 },
);
console.log(result.messages.at(-1)?.content);
