import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerGetTaskStatus(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'get_task_status',
    'Get the full details of a task including its notes history and current status.',
    {
      taskId: z.string().describe('The ID of the task to look up'),
    },
    async ({ taskId }) => {
      try {
        const task = await agentConnection.getTask(taskId);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(task),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to get task status: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
