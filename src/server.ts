import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageStore } from './stores/message-store.js';
import type { TaskStore } from './stores/task-store.js';
import type { PeerRegistryEntry } from './types.js';
import { registerListPeers } from './tools/list-peers.js';
import { registerSendMessage } from './tools/send-message.js';
import { registerGetMessages } from './tools/get-messages.js';
import { registerDelegateTask } from './tools/delegate-task.js';
import { registerGetTaskStatus } from './tools/get-task-status.js';
import { registerWaitForMessages } from './tools/wait-for-messages.js';
import { registerSetStatus } from './tools/set-status.js';
import { registerCompleteTask } from './tools/complete-task.js';
import { registerChatSend } from './tools/chat-send.js';
import { registerPrompts } from './prompts.js';
import type { DashboardServer } from './dashboard/http-server.js';

const SERVER_INSTRUCTIONS = `\
CrossChat lets you talk to other Claude Code instances on this machine. You can discover them, send messages, and delegate tasks.

Your identity: **{peerName}** (peer ID: {peerId}). You are automatically registered and discoverable.

## Tools summary
- \`list_peers\` — find other instances (includes status, name, working directory)
- \`send_message\` — send a message to a peer by ID
- \`get_messages\` — check your inbox (use unreadOnly=true for new messages)
- \`delegate_task\` — ask a peer to do work (returns taskId)
- \`get_task_status\` — check progress of a delegated task
- \`wait_for_messages\` — long-poll for incoming messages (for background listeners)
- \`set_status\` — set yourself as available or busy
- \`complete_task\` — report task results back to the delegator (use instead of send_message for task results)
- \`chat_send_message\` — post a message to the dashboard UI (if dashboard is running)

## Dashboard
{dashboardInfo}

## Key rules
- Use \`list_peers\` to discover peer IDs — never guess UUIDs.
- Check a peer's status before delegating — don't send work to busy peers.
- Set yourself to "busy" when working on a delegated task, "available" when done.
- When you finish a task and set status to "available", the peer who delegated is automatically notified.
- Messages are ephemeral — they don't survive restarts.

For full usage instructions, the user should run the /crosschat command.`;

export function createMcpServer(
  peerId: string,
  peerName: string,
  messageStore: MessageStore,
  taskStore: TaskStore,
  registryEntry: PeerRegistryEntry,
  dashboard: DashboardServer | null,
  dashboardInfo: { port: number } | { error: string } | null
): McpServer {
  let dashboardInfoStr: string;
  if (dashboardInfo && 'port' in dashboardInfo) {
    dashboardInfoStr = `Running at http://localhost:${dashboardInfo.port}`;
  } else if (dashboardInfo && 'error' in dashboardInfo) {
    dashboardInfoStr = `Failed to start: ${dashboardInfo.error}`;
  } else {
    dashboardInfoStr = 'Not available';
  }

  const instructions = SERVER_INSTRUCTIONS
    .replace('{peerName}', peerName)
    .replace('{peerId}', peerId)
    .replace('{dashboardInfo}', dashboardInfoStr);

  const server = new McpServer(
    {
      name: 'crosschat',
      version: '0.1.0',
      description: 'Inter-instance communication for Claude Code and other LLM agents on a single device.',
    },
    { instructions }
  );

  registerListPeers(server, peerId);
  registerSendMessage(server, peerId, peerName);
  registerGetMessages(server, messageStore);
  registerDelegateTask(server, peerId, peerName, taskStore);
  registerGetTaskStatus(server, taskStore);
  registerWaitForMessages(server, messageStore);
  registerSetStatus(server, registryEntry);
  registerCompleteTask(server, taskStore);
  if (dashboard) {
    registerChatSend(server, dashboard, peerName);
  }
  registerPrompts(server, peerId, peerName);

  return server;
}
