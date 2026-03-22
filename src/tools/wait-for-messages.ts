import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageStore } from '../stores/message-store.js';
import type { PeerMessage } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;

export function registerWaitForMessages(server: McpServer, messageStore: MessageStore): void {
  server.tool(
    'wait_for_messages',
    'Wait for the next message in your current room. Blocks until a message arrives or timeout.',
    {
      timeoutMs: z.number().optional().describe('How long to wait in milliseconds (default: 30000, max: 600000). Returns a timeout result if no message arrives.'),
      broadcastCooldownMs: z.number().optional().describe('Delay in ms before returning broadcast messages (not direct @mentions). Used to stagger responses across agents so earlier responders can be seen by later ones. Set this to a random value (0-500) seeded at init time.'),
    },
    async ({ timeoutMs, broadcastCooldownMs }) => {
      try {
        const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

        // Check for unread messages first — return immediately if any exist
        const existing = messageStore.getAll({ unreadOnly: true, limit: 1 });
        if (existing.length > 0) {
          messageStore.markAsRead([existing[0].messageId]);
          return buildResponse(existing[0], broadcastCooldownMs, messageStore);
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
        return buildResponse(message, broadcastCooldownMs, messageStore);
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

/**
 * Build the response for a received message, applying broadcast cooldown if configured.
 * Direct @mentions bypass the cooldown entirely.
 * For broadcast messages, waits the cooldown period then gathers any messages
 * that arrived during the wait as recentContext.
 */
async function buildResponse(
  message: PeerMessage,
  broadcastCooldownMs: number | undefined,
  messageStore: MessageStore,
) {
  const isDirect = message.mentionType === 'direct';

  // Direct mentions or no cooldown configured — return immediately
  if (isDirect || !broadcastCooldownMs || broadcastCooldownMs <= 0) {
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

  // Broadcast message with cooldown — wait, then gather context
  await new Promise((resolve) => setTimeout(resolve, broadcastCooldownMs));

  // Collect any messages that arrived during the cooldown (responses from other agents)
  const recentMessages = messageStore.getAll({ unreadOnly: true });
  if (recentMessages.length > 0) {
    messageStore.markAsRead(recentMessages.map((m) => m.messageId));
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          received: true,
          message,
          recentContext: recentMessages.length > 0 ? recentMessages : undefined,
          cooldownApplied: broadcastCooldownMs,
        }, null, 2),
      },
    ],
  };
}
