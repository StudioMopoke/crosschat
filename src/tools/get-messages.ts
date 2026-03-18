import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageStore } from '../stores/message-store.js';

export function registerGetMessages(server: McpServer, messageStore: MessageStore): void {
  server.tool(
    'get_messages',
    'Check your inbox for messages from other CrossChat peers. Returns messages with sender info (fromPeerId, fromName), content, timestamps, and read status. Messages prefixed with [TASK DELEGATED] are inbound tasks from delegate_task — these include a relatedTaskId. By default, returned messages are marked as read so subsequent calls with unreadOnly=true only show new messages. Use this to check for incoming communication, respond to questions, or pick up delegated tasks.',
    {
      fromPeerId: z.string().optional().describe('Only return messages from this specific peer ID'),
      afterMessageId: z.string().optional().describe('Only return messages received after this message ID (for pagination across multiple calls)'),
      limit: z.number().optional().describe('Maximum number of messages to return (default: all)'),
      unreadOnly: z.boolean().optional().describe('If true, only return messages that haven\'t been read yet. Useful for polling for new messages.'),
      markAsRead: z.boolean().optional().describe('Whether to mark returned messages as read (default: true). Set to false to peek without consuming.'),
    },
    async ({ fromPeerId, afterMessageId, limit, unreadOnly, markAsRead }) => {
      const messages = messageStore.getAll({
        fromPeerId,
        afterMessageId,
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
    }
  );
}
