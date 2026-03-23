import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageStore } from '../stores/message-store.js';
import type { AgentConnection } from '../hub/agent-connection.js';

export function registerGetMessages(server: McpServer, messageStore: MessageStore, agentConnection: AgentConnection): void {
  server.tool(
    'get_messages',
    'Get messages from the channel or a thread. Returns messages with badges for at-a-glance context. Use threadId to read replies in a thread.',
    {
      threadId: z.string().optional().describe('If set, fetch messages from this thread (the threadId is the messageId of the root message). Omit to get channel messages.'),
      limit: z.number().optional().describe('Maximum number of messages to return (default: all)'),
      unreadOnly: z.boolean().optional().describe('If true, only return unread messages (channel only)'),
      markAsRead: z.boolean().optional().describe('Whether to mark returned messages as read (default: true, channel only)'),
    },
    async ({ threadId, limit, unreadOnly, markAsRead }) => {
      try {
        if (threadId) {
          // Fetch thread messages from hub via AgentConnection
          const messages = await agentConnection.getMessages({ threadId, limit });
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ messages, count: messages.length, threadId }, null, 2),
              },
            ],
          };
        }

        // Channel messages from local MessageStore
        const messages = messageStore.getAll({
          limit,
          unreadOnly,
        });

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
