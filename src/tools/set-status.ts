import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerSetStatus(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'set_status',
    'Set your availability status so other peers can see if you\'re free or busy.',
    {
      status: z.enum(['available', 'busy']).describe('"available" = ready for work, "busy" = currently working on something'),
      detail: z.string().optional().describe('What you\'re doing (e.g., "Running tests for auth module"). Shown to other peers in list_peers.'),
      taskMessageId: z.string().optional().describe('The messageId of the flagged task you\'re working on, if applicable'),
    },
    async ({ status, detail, taskMessageId }) => {
      try {
        agentConnection.setStatus(status, detail, taskMessageId);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ status, detail }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to set status: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
