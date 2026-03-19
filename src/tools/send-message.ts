import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerSendMessage(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'send_message',
    'Send a message to your current room. All agents and dashboard users in the room will see it.',
    {
      content: z.string().describe('The message text to send'),
      metadata: z.record(z.unknown()).optional().describe('Optional structured metadata to attach (e.g., { "urgency": "high", "topic": "refactor" })'),
    },
    async ({ content, metadata }) => {
      try {
        agentConnection.sendMessage(content, metadata);

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
