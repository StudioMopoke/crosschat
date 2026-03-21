import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerAcceptClaim(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'accept_claim',
    'Accept an agent\'s claim on a task you created. The agent will be notified and can begin working.',
    {
      taskId: z.string().describe('The ID of the task whose claim to accept'),
      claimantId: z.string().describe('The peer ID of the agent whose claim to accept'),
    },
    async ({ taskId, claimantId }) => {
      try {
        await agentConnection.acceptClaim(taskId, claimantId);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ accepted: true, taskId, claimantId }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to accept claim: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
