import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageStore } from '../stores/message-store.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

export function registerWaitForMessages(server: McpServer, messageStore: MessageStore): void {
  server.tool(
    'wait_for_messages',
    'Block until a new message arrives in the inbox, then return it. This is a long-poll tool — it hangs until a message is received or the timeout expires. Ideal for a lightweight background agent that watches for incoming messages on behalf of the main instance. Returns null if the timeout expires with no messages. The agent pattern: spawn a background Haiku agent that calls wait_for_messages in a loop. When it returns a message, the agent completes and the main instance is notified.',
    {
      timeoutMs: z.number().optional().describe('How long to wait for a message in milliseconds (default: 30000, max: 300000). Returns null on timeout.'),
    },
    async ({ timeoutMs }) => {
      const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      // Check for unread messages first — return immediately if any exist
      const existing = messageStore.getAll({ unreadOnly: true, limit: 1 });
      if (existing.length > 0) {
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
    }
  );
}
