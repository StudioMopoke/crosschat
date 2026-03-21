import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerListTasks(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'list_tasks',
    'List tasks with optional filters. Shows task status, assignee, and creation info.',
    {
      status: z.string().optional().describe('Filter by task status (e.g., "open", "claimed", "in_progress", "completed", "failed", "archived")'),
      roomId: z.string().optional().describe('Filter by the room the task was created in'),
      assignedTo: z.string().optional().describe('Filter by the peer ID of the assigned agent'),
    },
    async ({ status, roomId, assignedTo }) => {
      try {
        const result = await agentConnection.listTasks({ status, roomId, assignedTo });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ tasks: result.tasks, count: result.tasks.length }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to list tasks: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
