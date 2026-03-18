import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readRegistryEntry, removeRegistryEntry, removeSocketFile } from '../registry/registry.js';
import { sendPeerRequest } from '../transport/uds-client.js';
import { generateId } from '../util/id.js';
import type { PeerMessageParams } from '../types.js';

export function registerSendMessage(server: McpServer, ownPeerId: string, ownName: string): void {
  server.tool(
    'send_message',
    'Send a text message to another CrossChat peer. The message is delivered directly to the peer\'s inbox via Unix domain socket. On success, returns the messageId and target peer name. If the peer has shut down or is unreachable, returns an error and automatically removes the stale registry entry. Use list_peers first to get valid peer IDs.',
    {
      targetPeerId: z.string().describe('The UUID of the target peer (from list_peers results)'),
      content: z.string().describe('The message text to send. Can include any content — questions, status updates, instructions, code snippets, etc.'),
      metadata: z.record(z.unknown()).optional().describe('Optional structured metadata to attach (e.g., { "urgency": "high", "topic": "refactor" }). The peer receives this alongside the message content.'),
    },
    async ({ targetPeerId, content, metadata }) => {
      const entry = await readRegistryEntry(targetPeerId);
      if (!entry) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Peer not found' }) }],
          isError: true,
        };
      }

      const params: PeerMessageParams = {
        messageId: generateId(),
        fromPeerId: ownPeerId,
        fromName: ownName,
        content,
        metadata,
        sentAt: new Date().toISOString(),
      };

      try {
        const response = await sendPeerRequest(entry.socketPath, 'peer.message', params as unknown as Record<string, unknown>);
        if (response.error) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: response.error.message }) }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                sent: true,
                messageId: params.messageId,
                targetPeerId,
                targetName: entry.name,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        // Connection failed — peer is likely dead, prune it
        if (err instanceof Error && ('code' in err && ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' || (err as NodeJS.ErrnoException).code === 'ENOENT'))) {
          await removeRegistryEntry(targetPeerId);
          await removeSocketFile(targetPeerId);
        }
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to reach peer: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
