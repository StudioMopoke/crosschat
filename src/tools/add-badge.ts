import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerAddBadge(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'add_badge',
    'Add a metadata badge to any message. Badges provide at-a-glance context — importance, question, git commit, project, etc. Rendered as visual badges in the dashboard.',
    {
      messageId: z.string().describe('The messageId to add a badge to'),
      badgeType: z.string().describe('Badge type (e.g., "importance", "question", "git-commit", "project")'),
      badgeValue: z.string().describe('Badge value (e.g., "high", "true", "abc1234", "crosschat")'),
      label: z.string().optional().describe('Optional human-readable display label'),
    },
    async ({ messageId, badgeType, badgeValue, label }) => {
      try {
        const result = await agentConnection.addBadge(messageId, badgeType, badgeValue, label);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ added: true, messageId: result.messageId, badge: result.badge }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to add badge: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
