import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DashboardServer } from '../dashboard/http-server.js';

export function registerChatSend(server: McpServer, dashboard: DashboardServer, peerName: string): void {
  server.tool(
    'chat_send_message',
    'Post a message directly to the CrossChat dashboard UI. This is visible to users watching the dashboard in their browser. Use this for human-readable status updates, summaries, or to participate in dashboard conversations. Messages sent via send_message between peers are already mirrored to the dashboard automatically — use this tool when you want to post something specifically for the dashboard audience.',
    {
      roomId: z.string().optional().describe('The room ID to post to (default: "general"). Use "crosschat" for the auto-mirrored activity feed.'),
      text: z.string().describe('The message text to post'),
      username: z.string().optional().describe('Override the username (default: your peer name)'),
    },
    async ({ roomId, text, username }) => {
      const room = roomId || 'general';
      const name = username || peerName;
      dashboard.postToRoom(room, name, text);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ posted: true, roomId: room, username: name }),
        }],
      };
    }
  );
}
