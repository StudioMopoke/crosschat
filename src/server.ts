import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };
import type { MessageStore } from './stores/message-store.js';
import type { AgentConnection } from './hub/agent-connection.js';
import { registerSendMessage } from './tools/send-message.js';
import { registerGetMessages } from './tools/get-messages.js';
import { registerWaitForMessages } from './tools/wait-for-messages.js';
import { registerListPeers } from './tools/list-peers.js';
import { registerSetStatus } from './tools/set-status.js';
import { registerJoinRoom } from './tools/join-room.js';
import { registerCreateRoom } from './tools/create-room.js';
import { registerDelegateTask } from './tools/delegate-task.js';
import { registerClaimTask } from './tools/claim-task.js';
import { registerAcceptClaim } from './tools/accept-claim.js';
import { registerUpdateTask } from './tools/update-task.js';
import { registerCompleteTask } from './tools/complete-task.js';
import { registerListTasks } from './tools/list-tasks.js';
import { registerGetTaskStatus } from './tools/get-task-status.js';
import { registerClearSession } from './tools/clear-session.js';
import { registerGetRoomDigest } from './tools/get-room-digest.js';
import { registerPrompts } from './prompts.js';

const SERVER_INSTRUCTIONS = `\
CrossChat connects you to other Claude Code instances on this machine through a central hub server. \
All communication happens through rooms — you are in one room at a time (default: "general").

Your identity: **{peerName}** (peer ID: {peerId}). You are automatically registered and discoverable.

## @mentions
\`@agent-name\` delivers only to that agent. \`@here\` broadcasts to everyone. No mention = broadcast to all.

## Task lifecycle
Tasks follow: **delegate -> claim -> accept -> update -> complete**

## Dashboard
{dashboardInfo}

## Key rules
- Use \`list_peers\` to discover peer IDs — never guess UUIDs.
- All messaging is room-based — no direct P2P messaging.
- Check a peer's status before delegating — don't send work to busy peers.
- Set yourself to "busy" when working on a task, "available" when done.
- Tasks are persistent and survive hub restarts. Messages are ephemeral.
- Rooms are capped at 200 messages. Old messages are digested automatically via the task system.
- Use \`get_room_digest\` when joining a room to catch up on prior discussion.
- Tag messages with \`importance\`: "important", "comment" (default), or "chitchat".

For full usage instructions, the user should run the /crosschat command.`;

export function createMcpServer(
  peerId: string,
  peerName: string,
  messageStore: MessageStore,
  agentConnection: AgentConnection,
  dashboardInfo: { port: number } | { error: string }
): McpServer {
  let dashboardInfoStr: string;
  if ('port' in dashboardInfo) {
    dashboardInfoStr = `Running at http://localhost:${dashboardInfo.port}`;
  } else {
    dashboardInfoStr = `Failed to start: ${dashboardInfo.error}`;
  }

  const instructions = SERVER_INSTRUCTIONS
    .replace('{peerName}', peerName)
    .replace('{peerId}', peerId)
    .replace('{dashboardInfo}', dashboardInfoStr);

  const server = new McpServer(
    {
      name: 'crosschat',
      version: pkg.version,
      description: 'Inter-instance communication for Claude Code and other LLM agents on a single device.',
    },
    { instructions }
  );

  // --- Messaging tools ---
  registerSendMessage(server, agentConnection);
  registerGetMessages(server, messageStore);
  registerWaitForMessages(server, messageStore);

  // --- Peer tools ---
  registerListPeers(server, agentConnection);
  registerSetStatus(server, agentConnection);

  // --- Room tools ---
  registerJoinRoom(server, agentConnection);
  registerCreateRoom(server, agentConnection);

  // --- Session tools ---
  registerClearSession(server, agentConnection, messageStore);

  // --- Digest tools ---
  registerGetRoomDigest(server, agentConnection);

  // --- Task tools ---
  registerDelegateTask(server, agentConnection);
  registerClaimTask(server, agentConnection);
  registerAcceptClaim(server, agentConnection);
  registerUpdateTask(server, agentConnection);
  registerCompleteTask(server, agentConnection);
  registerListTasks(server, agentConnection);
  registerGetTaskStatus(server, agentConnection);

  // --- Prompts ---
  registerPrompts(server, peerId, peerName);

  return server;
}
