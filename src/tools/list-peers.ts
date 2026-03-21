import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerListPeers(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'list_peers',
    'List all connected CrossChat instances. Shows name, status, working directory, and current room.',
    {
      includeMetadata: z.boolean().optional().describe('Kept for compatibility — metadata is always included now'),
    },
    async () => {
      try {
        const peers = await agentConnection.listPeers();

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ peers, count: peers.length }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to list peers: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
