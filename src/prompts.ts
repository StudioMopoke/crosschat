import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer, peerId: string, peerName: string): void {
  server.prompt(
    'check-inbox',
    'Check for new messages and delegated tasks from other CrossChat peers.',
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Check your CrossChat inbox for any new messages or delegated tasks. Use get_messages with unreadOnly=true. For each message:
- If it's a regular message, summarize who sent it and what they said.
- If it's a delegated task (content starts with [TASK DELEGATED]), describe the task and ask me if I'd like you to work on it.
If there are no new messages, just say the inbox is empty.`,
          },
        },
      ],
    })
  );

  server.prompt(
    'discover-peers',
    'Find all active CrossChat instances and what they\'re working on.',
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Use list_peers with includeMetadata=true to discover all active CrossChat instances. For each peer, tell me:
- Their name and peer ID
- Their status (available or busy)
- What directory they're working in (from metadata.cwd)
If no peers are found, let me know I'm the only active instance.`,
          },
        },
      ],
    })
  );

  server.prompt(
    'my-identity',
    'Show your CrossChat identity.',
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Report your CrossChat identity. You are:
- Name: ${peerName}
- Peer ID: ${peerId}
- Working directory: ${process.env.CROSSCHAT_CWD || process.cwd()}

Tell me this info and explain that other peers can message me using my peer ID.`,
          },
        },
      ],
    })
  );
}
