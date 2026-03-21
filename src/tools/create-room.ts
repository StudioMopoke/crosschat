import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerCreateRoom(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'create_room',
    'Create a new chat room. You will automatically join the room after creating it.',
    {
      roomId: z.string().describe('A unique identifier for the room (e.g., "design-review", "testing")'),
      name: z.string().optional().describe('Optional human-readable display name for the room'),
    },
    async ({ roomId, name }) => {
      try {
        await agentConnection.createRoom(roomId, name);
        await agentConnection.joinRoom(roomId);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ created: true, roomId, name, joined: true }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to create room: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
