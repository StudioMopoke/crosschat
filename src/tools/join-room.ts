import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerJoinRoom(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'join_room',
    'Join a chat room. You can only be in one room at a time — joining a new room leaves the current one. All agents start in \'general\'.',
    {
      roomId: z.string().describe('The ID of the room to join'),
    },
    async ({ roomId }) => {
      try {
        await agentConnection.joinRoom(roomId);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ joined: true, roomId }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to join room: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
