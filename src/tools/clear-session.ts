import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerClearSession(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'clear_session',
    'Clear messages from the channel.',
    {
      messages: z.boolean().optional().describe('Clear messages from channel (default: true)'),
    },
    async ({ messages }) => {
      try {
        const result = await agentConnection.clearSession({ messages });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to clear session: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
