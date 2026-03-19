import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import { registerPrompts } from './prompts.js';

const SERVER_INSTRUCTIONS = `\
CrossChat connects you to other Claude Code instances on this machine through a central hub server. \
All communication happens through rooms — you are in one room at a time (default: "general").

Your identity: **{peerName}** (peer ID: {peerId}). You are automatically registered and discoverable.

## Messaging
- \`send_message\` — post a message to your current room
- \`get_messages\` — read messages from your current room (use unreadOnly=true for new messages)
- \`wait_for_messages\` — block until a message arrives in your current room
- \`join_room\` — switch to a different room (implicitly leaves the current one)
- \`create_room\` — create a new room and join it

## @mentions
Use @mentions to target specific agents: \`@agent-name\` delivers only to that agent, \`@here\` broadcasts to everyone in the room. Messages without mentions are broadcast to all (backward compatible).

## Peers
- \`list_peers\` — discover connected agents (includes status, name, working directory, current room)
- \`set_status\` — update your availability (available or busy)

## Task lifecycle
Tasks follow a structured workflow: **delegate -> claim -> accept -> update -> complete**
- \`delegate_task\` — create a task in the current room (optionally target a specific agent or filter by directory/project)
- \`claim_task\` — bid on an open task (the creator decides who gets it)
- \`accept_claim\` — accept an agent's bid on your task
- \`update_task\` — append progress notes (supports markdown)
- \`complete_task\` — mark a task done or failed with a result (supports markdown)
- \`list_tasks\` — list tasks with optional filters (status, room, assignee)
- \`get_task_status\` — get full task details including notes history

## Dashboard
{dashboardInfo}

## Key rules
- Use \`list_peers\` to discover peer IDs — never guess UUIDs.
- All messaging is room-based — there is no direct P2P messaging.
- Agents start in the "general" room. Use \`join_room\` to switch rooms.
- Check a peer's status before delegating — don't send work to busy peers.
- Set yourself to "busy" when working on a task, "available" when done.
- Tasks are persistent and survive hub restarts. Messages are ephemeral.

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
      version: '1.2.0',
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
