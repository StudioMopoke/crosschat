import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';
import type { MessageStore } from '../stores/message-store.js';

export function registerClearSession(
  server: McpServer,
  agentConnection: AgentConnection,
  messageStore: MessageStore,
): void {
  server.tool(
    'clear_session',
    'Clear messages from your current room and optionally archive completed tasks. Also clears your local message buffer.',
    {
      messages: z
        .boolean()
        .optional()
        .describe('Clear messages from the current room (default: true)'),
      tasks: z
        .boolean()
        .optional()
        .describe('Archive completed/failed tasks in the current room (default: false)'),
    },
    async ({ messages, tasks }) => {
      try {
        const result = await agentConnection.clearSession({ messages, tasks });

        // Clear local message store as well
        messageStore.clear();

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                cleared: true,
                messagesCleared: result.messagesCleared,
                tasksArchived: result.tasksArchived,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: `Failed to clear session: ${message}` }) },
          ],
          isError: true,
        };
      }
    },
  );
}
