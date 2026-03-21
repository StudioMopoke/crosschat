import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentConnection } from '../hub/agent-connection.js';

const DIGESTS_DIR = path.join(os.homedir(), '.crosschat', 'digests');

export function registerGetRoomDigest(server: McpServer, agentConnection: AgentConnection): void {
  server.tool(
    'get_room_digest',
    'Get the most recent digest summary for a room. Useful for catching up on room history after joining.',
    {
      roomId: z.string().optional().describe('Room ID to get the digest for (defaults to your current room)'),
    },
    async ({ roomId }) => {
      try {
        const targetRoomId = roomId || agentConnection.getCurrentRoom();
        const roomDigestDir = path.join(DIGESTS_DIR, targetRoomId);

        let entries: string[];
        try {
          const dirEntries = await fs.readdir(roomDigestDir);
          entries = dirEntries.filter((e) => e.endsWith('.md')).sort();
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ digest: null, message: `No digests available for room "${targetRoomId}"` }),
              },
            ],
          };
        }

        if (entries.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ digest: null, message: `No digests available for room "${targetRoomId}"` }),
              },
            ],
          };
        }

        // Read the most recent digest
        const latestFile = entries[entries.length - 1];
        const digestContent = await fs.readFile(path.join(roomDigestDir, latestFile), 'utf-8');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                roomId: targetRoomId,
                digestFile: latestFile,
                digest: digestContent,
              }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to get room digest: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
