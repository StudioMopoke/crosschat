import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerCompleteTask(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'complete_task',
    'Mark a task as completed or failed. Include a markdown result documenting the work done.',
    {
      taskId: z.string().describe('The ID of the task to complete'),
      status: z.enum(['completed', 'failed']).describe('"completed" if the task was done successfully, "failed" if it could not be completed'),
      result: z.string().describe('The result of the task as markdown. Include enough detail for the creator to understand what was done.'),
      error: z.string().optional().describe('Error description if the task failed'),
    },
    async ({ taskId, status, result, error }) => {
      try {
        agentConnection.completeTask(taskId, result, status, error);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ completed: true, taskId, status }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to complete task: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
