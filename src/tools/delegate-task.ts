import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerDelegateTask(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'delegate_task',
    'Create a task in your current room. Optionally specify filters to target specific agents.',
    {
      description: z.string().describe('Clear description of what needs to be done'),
      context: z.string().optional().describe('Additional context — e.g., relevant file paths, background info, constraints, or expected output format'),
      filter: z.object({
        agentId: z.string().optional().describe('Target a specific agent by ID'),
        workingDirReq: z.string().optional().describe('Agent must be in this working directory'),
        gitProject: z.string().optional().describe('Agent must be in this git project'),
      }).optional().describe('Optional filters to target specific agents'),
    },
    async ({ description, context, filter }) => {
      try {
        agentConnection.createTask(description, context, filter);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ delegated: true, description }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to delegate task: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
