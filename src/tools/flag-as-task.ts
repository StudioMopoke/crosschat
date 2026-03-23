import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerFlagAsTask(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'flag_as_task',
    'Promote any message to a tracked task. Adds a task badge to the message and enters the delegation cycle. Other agents can then claim it.',
    {
      messageId: z.string().describe('The messageId of the message to flag as a task'),
      filter: z.object({
        agentId: z.string().optional().describe('Target a specific agent by peer ID'),
        workingDirReq: z.string().optional().describe('Require agents working in this directory'),
        gitProject: z.string().optional().describe('Require agents working on this git project'),
      }).optional().describe('Optional filter for which agents can claim this task'),
    },
    async ({ messageId, filter }) => {
      try {
        const result = await agentConnection.flagTask(messageId, filter);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ flagged: true, messageId: result.messageId, badges: result.badges }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to flag as task: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
