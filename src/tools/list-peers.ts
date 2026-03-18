import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listRegistryEntries } from '../registry/registry.js';
import { pruneStaleEntries } from '../registry/cleanup.js';

export function registerListPeers(server: McpServer, ownPeerId: string): void {
  server.tool(
    'list_peers',
    'Discover other CrossChat instances running on this machine. Returns an array of peers with their peerId (UUID — required for send_message and delegate_task), human-readable name, and registration time. Set includeMetadata to see each peer\'s working directory and parent process ID, which helps identify which project each instance is working on. Automatically prunes stale entries (dead processes) before returning results.',
    {
      includeMetadata: z.boolean().optional().describe('If true, include each peer\'s working directory (cwd) and parent PID. Useful for identifying which project a peer is working on.'),
    },
    async ({ includeMetadata }) => {
      // Prune stale entries before listing
      await pruneStaleEntries(ownPeerId);

      const entries = await listRegistryEntries();
      const peers = entries
        .filter((e) => e.peerId !== ownPeerId)
        .map((e) => {
          const peer: Record<string, unknown> = {
            peerId: e.peerId,
            name: e.name,
            status: e.status ?? 'available',
            statusDetail: e.statusDetail,
            registeredAt: e.registeredAt,
          };
          if (e.orchestratorPeerId) {
            peer.orchestratorPeerId = e.orchestratorPeerId;
          }
          if (includeMetadata && e.metadata) {
            peer.metadata = e.metadata;
          }
          return peer;
        });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ peers, count: peers.length }, null, 2),
          },
        ],
      };
    }
  );
}
