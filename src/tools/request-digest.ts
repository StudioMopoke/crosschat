import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerRequestDigest(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'request_digest',
    'Request a digest of the current room messages. Creates a task for an agent to summarize the conversation. Optionally clears messages after capturing them.',
    {
      clearMessages: z
        .boolean()
        .optional()
        .describe('Clear room messages after capturing them for the digest (default: false)'),
    },
    async ({ clearMessages }) => {
      try {
        const result = await agentConnection.requestDigest({ clearMessages });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                taskId: result.taskId,
                messageCount: result.messageCount,
                messagesCleared: result.messagesCleared,
                message: `Digest task created for ${result.messageCount} message(s). Task ID: ${result.taskId}. An agent needs to claim and complete this task to generate the digest.`,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: `Failed to request digest: ${message}` }) },
          ],
          isError: true,
        };
      }
    },
  );
}
