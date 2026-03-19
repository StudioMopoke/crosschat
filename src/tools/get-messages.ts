import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageStore } from '../stores/message-store.js';

export function registerGetMessages(server: McpServer, messageStore: MessageStore): void {
  server.tool(
    'get_messages',
    'Get messages from your current room. Returns messages received since you joined.',
    {
      limit: z.number().optional().describe('Maximum number of messages to return (default: all)'),
      unreadOnly: z.boolean().optional().describe('If true, only return unread messages'),
      markAsRead: z.boolean().optional().describe('Whether to mark returned messages as read (default: true). Set to false to peek without consuming.'),
    },
    async ({ limit, unreadOnly, markAsRead }) => {
      try {
        const messages = messageStore.getAll({
          limit,
          unreadOnly,
        });

        // Mark as read by default
        if (markAsRead !== false && messages.length > 0) {
          messageStore.markAsRead(messages.map((m) => m.messageId));
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ messages, count: messages.length }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to get messages: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
