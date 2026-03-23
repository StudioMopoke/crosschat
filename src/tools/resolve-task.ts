import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerResolveTask(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'resolve_task',
    'Complete or fail a task. Only the claimant can resolve. Include a result documenting the work done.',
    {
      messageId: z.string().describe('The messageId of the flagged task message to resolve'),
      status: z.enum(['completed', 'failed']).describe('"completed" if done successfully, "failed" if not'),
      result: z.string().describe('The result of the task as markdown'),
      error: z.string().optional().describe('Error description if the task failed'),
    },
    async ({ messageId, status, result, error }) => {
      try {
        const res = await agentConnection.resolveTask(messageId, status, result, error);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ resolved: true, messageId: res.messageId, status: res.status }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to resolve task: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
