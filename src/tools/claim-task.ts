import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerClaimTask(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'claim_task',
    'Claim an open task. The task creator will be notified of your bid and must accept it before you can start working.',
    {
      taskId: z.string().describe('The ID of the task to claim (from list_tasks or a task announcement in the room)'),
    },
    async ({ taskId }) => {
      try {
        await agentConnection.claimTask(taskId);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ claimed: true, taskId }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to claim task: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
