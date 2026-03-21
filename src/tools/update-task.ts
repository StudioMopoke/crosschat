import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerUpdateTask(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'update_task',
    'Add a progress note to a task. Supports markdown content for documenting work done, decisions made, or blockers encountered.',
    {
      taskId: z.string().describe('The ID of the task to update'),
      content: z.string().describe('Markdown content for the progress note — work done, decisions made, blockers, etc.'),
      status: z.enum(['in_progress', 'open']).optional().describe('Optionally update the task status'),
    },
    async ({ taskId, content, status }) => {
      try {
        await agentConnection.updateTask(taskId, content, status);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ updated: true, taskId }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to update task: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
