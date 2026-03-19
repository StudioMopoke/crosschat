import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageStore } from '../stores/message-store.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;

export function registerWaitForMessages(server: McpServer, messageStore: MessageStore): void {
  server.tool(
    'wait_for_messages',
    'Wait for the next message in your current room. Blocks until a message arrives or timeout.',
    {
      timeoutMs: z.number().optional().describe('How long to wait in milliseconds (default: 30000, max: 600000). Returns a timeout result if no message arrives.'),
    },
    async ({ timeoutMs }) => {
      try {
        const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

        // Check for unread messages first — return immediately if any exist
        const existing = messageStore.getAll({ unreadOnly: true, limit: 1 });
        if (existing.length > 0) {
          messageStore.markAsRead([existing[0].messageId]);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  received: true,
                  message: existing[0],
                }, null, 2),
              },
            ],
          };
        }

        // Block until a message arrives or timeout
        const message = await messageStore.waitForNext(timeout);

        if (!message) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ received: false, reason: 'timeout' }),
              },
            ],
          };
        }

        messageStore.markAsRead([message.messageId]);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                received: true,
                message,
              }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to wait for messages: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
