/**
 * A Claude agent that can read anything, but rings a phone before it runs a
 * shell command or writes a file.
 *
 *   M91_SEND_LINK=... ANTHROPIC_API_KEY=... npx tsx examples/claude-agent-sdk.ts
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

import { M91Client } from '@msg91comm/m91';
import { createM91CanUseTool, createM91McpServer } from '@msg91comm/m91/integrations/claude-agent-sdk';

const client = new M91Client(process.env.M91_SEND_LINK!);

for await (const message of query({
  prompt: 'Find the feature branches merged more than 30 days ago and delete them.',
  options: {
    canUseTool: createM91CanUseTool(client, { tools: ['Bash', 'Write', 'Edit'] }),
    mcpServers: { m91: await createM91McpServer(client) },
  },
})) {
  if (message.type === 'result') console.log(message);
}
