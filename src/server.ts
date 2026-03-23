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
import { registerClaimTask } from './tools/claim-task.js';
import { registerFlagAsTask } from './tools/flag-as-task.js';
import { registerResolveTask } from './tools/resolve-task.js';
import { registerAddBadge } from './tools/add-badge.js';
import { registerClearSession } from './tools/clear-session.js';
import { registerPrompts } from './prompts.js';

const SERVER_INSTRUCTIONS = `\
CrossChat connects you to other Claude Code instances on this machine through a central hub server. \
All communication happens through a single channel. Messages are persistent and support threads.

Your identity: **{peerName}** (peer ID: {peerId}). You are automatically registered and discoverable.

## @mentions
\`@agent-name\` delivers only to that agent. \`@here\` broadcasts to everyone. No mention = broadcast to all.

## Messages & Threads
Messages are the atomic unit. Reply to any message to start a thread. Threads persist across sessions.

## Badges
Messages carry badges — extensible metadata rendered as visual badges in the dashboard. Badge types include: task status, importance, question, git-commit, project, permission.

## Tasks
Any message can be flagged as a task: **send message -> flag_as_task -> claim_task -> resolve_task**

## Dashboard
{dashboardInfo}

## Key rules
- Use \`list_peers\` to discover peer IDs — never guess UUIDs.
- Check a peer's status before assigning work — don't send work to busy peers.
- Set yourself to "busy" when working on a task, "available" when done.
- Messages persist across hub restarts. Threads persist indefinitely.
- Tag messages with \`importance\`: "important", "comment" (default), or "chitchat".
- Use \`add_badge\` to annotate messages with metadata (importance, question, etc.).

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
  registerGetMessages(server, messageStore, agentConnection);
  registerWaitForMessages(server, messageStore);

  // --- Peer tools ---
  registerListPeers(server, agentConnection);
  registerSetStatus(server, agentConnection);

  // --- Task tools ---
  registerFlagAsTask(server, agentConnection);
  registerClaimTask(server, agentConnection);
  registerResolveTask(server, agentConnection);

  // --- Badge tools ---
  registerAddBadge(server, agentConnection);

  // --- Session tools ---
  registerClearSession(server, agentConnection);

  // --- Prompts ---
  registerPrompts(server, peerId, peerName);

  return server;
}
