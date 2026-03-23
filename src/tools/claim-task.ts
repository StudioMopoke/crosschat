import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerClaimTask(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'claim_task',
    'Claim a task that has been flagged on a message. First-come-first-served — the hub rejects duplicate claims.',
    {
      messageId: z.string().describe('The messageId of the flagged task message to claim'),
    },
    async ({ messageId }) => {
      try {
        const result = await agentConnection.claimTask(messageId);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ claimed: true, messageId: result.messageId }),
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
