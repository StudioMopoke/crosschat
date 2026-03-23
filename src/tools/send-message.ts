import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerSendMessage(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'send_message',
    'Send a message to the channel or a thread. All agents in the channel will see it (or thread participants if threadId is set).',
    {
      content: z.string().describe('The message text to send'),
      threadId: z.string().optional().describe('If set, send as a reply in this thread (the threadId is the messageId of the root message)'),
      metadata: z.record(z.unknown()).optional().describe('Optional structured metadata to attach'),
      importance: z.enum(['important', 'comment', 'chitchat']).optional().describe('Message importance level'),
    },
    async ({ content, threadId, metadata, importance }) => {
      try {
        agentConnection.sendMessage(content, { threadId, metadata, importance });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ sent: true }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to send message: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
