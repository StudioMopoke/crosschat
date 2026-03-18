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
import { registerPrompts } from './prompts.js';

const SERVER_INSTRUCTIONS = `\
CrossChat enables communication between Claude Code instances (or other LLM agents) running on the same machine. You can discover peers, send messages, and delegate tasks to other instances.

## Your identity
- **Name**: {peerName}
- **Peer ID**: {peerId}

You are automatically registered and discoverable by other instances. You do not need to do anything to register — it happened when this server started. Other peers can see you via their own list_peers and can send you messages using your peer ID.

## Finding peers

Call \`list_peers\` to discover other running instances. Each peer has:
- **peerId** — a UUID you'll need for send_message and delegate_task
- **name** — a human-readable label (e.g., "frontend-worker", "test-runner")
- **status** — "available" (ready for work) or "busy" (currently working on something)
- **statusDetail** — what they're currently doing if busy (e.g., "Running tests for auth module")
- **orchestratorPeerId** — if busy, the peer ID of the orchestrator that assigned the work
- **metadata.cwd** — the directory they're working in (pass includeMetadata=true)

Use metadata to identify the right peer. For example, if the user says "ask the instance working on the API", call list_peers with includeMetadata=true, find the peer whose cwd contains the API project path, and use that peer's ID.

**Respect peer status.** If a peer's status is "busy", do not delegate new tasks to them — they are already working for another orchestrator. If you need to reach a busy peer urgently, you can still send_message, but prefer available peers for new work.

If no peers are found, you're the only running instance. Let the user know — they may need to start another Claude Code session with CrossChat enabled.

If the peer you're looking for isn't listed, it may not have started yet. Let the user know and suggest they check that CrossChat is configured in the other instance.

## Sending messages

Call \`send_message\` with a peer's ID and your message content. The message is delivered directly to the peer's inbox. Use this for:
- Asking questions ("What branch are you working on?")
- Sharing information ("I just pushed a fix for the auth bug")
- Coordinating work ("I'll handle the frontend, can you update the API?")
- Responding to a message you received (just send_message back to the sender's peerId)

## Reading your inbox

Call \`get_messages\` to see messages other peers have sent you. Messages include:
- **fromPeerId** / **fromName** — who sent it (use fromPeerId to reply via send_message)
- **content** — the message text
- **relatedTaskId** — set if this message is about a delegated task

Messages starting with \`[TASK DELEGATED]\` are inbound tasks from delegate_task — see "Receiving delegated tasks" below.

Tip: use \`unreadOnly=true\` to see only new messages. Use \`markAsRead=false\` to peek without consuming.

## Managing your status

Use \`set_status\` to tell other peers whether you're available or busy:
- Call \`set_status\` with status="busy" when you start working on a delegated task. Include a \`detail\` (what you're doing), the \`taskId\`, and the \`orchestratorPeerId\` of whoever assigned the work.
- Call \`set_status\` with status="available" when you finish. **This automatically notifies the orchestrator** that you're done and available for more work — you don't need to send a separate message.

This is how peers avoid getting double-booked: orchestrators check list_peers and skip peers whose status is "busy".

## Delegating tasks

To ask another instance to do work:
1. Call \`list_peers\` to find the right peer — **check that their status is "available"**.
2. Call \`delegate_task\` with the peer's ID, a clear description, and any relevant context (file paths, constraints, expected output).
3. You get back a \`taskId\`.
4. Poll \`get_task_status\` with that taskId to check progress.
5. Optionally, set up a background listener (see below) to hear back when the task completes or the peer becomes available again.

Statuses: pending → in_progress → completed / failed / timed_out.

## Receiving delegated tasks

When another peer delegates a task to you, it appears in your inbox (via get_messages) as a message with:
- Content prefixed with \`[TASK DELEGATED]\`
- A \`relatedTaskId\` field

When you receive one:
1. Call \`set_status\` with status="busy", the task description, the taskId from relatedTaskId, and the sender's peerId as orchestratorPeerId.
2. Do the work.
3. Send the result back to the delegating peer via \`send_message\`.
4. Call \`set_status\` with status="available" — this notifies the orchestrator you're done.

## Listening for messages (background listener pattern)

You will NOT be automatically notified when a message arrives. To receive messages reactively, use the background listener pattern:

### How it works
1. Spawn a lightweight background sub-agent (use the cheapest/fastest model available, e.g., Haiku).
2. The sub-agent's only job: call the \`wait_for_messages\` tool, which blocks until a message arrives or times out (default 30s, max 5min).
3. If a message arrives, the sub-agent returns it to you. If it times out with no messages, the sub-agent returns \`{ received: false, reason: "timeout" }\`.
4. When you receive notification that the sub-agent completed:
   - If it returned a message: process it (reply, act on a task, inform the user, etc.), then spawn a new listener.
   - If it timed out: spawn a new listener to keep waiting, or stop if listening is no longer needed.

### Example (Claude Code agent tool)
To start listening:
\`\`\`
Spawn a background agent with this prompt:
"Call the wait_for_messages CrossChat tool with timeoutMs=60000. Return whatever it returns."
\`\`\`
When notified the agent completed, read its result. If a message was received, handle it and spawn another listener. This creates an event loop driven by the message arrivals themselves — no busy-polling, minimal token usage.

### When to set up a listener
- When the user says "listen for messages", "watch for messages", or "keep an eye on CrossChat"
- After delegating a task to a peer (to hear back when they complete it)
- When the user is expecting communication from another instance
- When the user asks you to coordinate ongoing work across instances

### Important
- Always run the listener agent in the background so you can continue doing other work.
- The sub-agent should be minimal — just call wait_for_messages and return. Don't give it complex instructions.
- If you no longer need to listen (user says stop, conversation ending, etc.), simply don't spawn a new listener.

## Common scenarios

### "Ask the other instance to run the tests"
1. list_peers (includeMetadata=true) → find the peer by cwd
2. delegate_task → send the task with context about what to test
3. Start a background listener to hear back
4. When the result arrives, report it to the user

### "Tell the other instance I'm done with the refactor"
1. list_peers → find the peer
2. send_message → "Refactor of auth module is complete. Changes are on branch feature/auth-v2."

### "Check if anyone has sent me anything"
1. get_messages (unreadOnly=true)
2. Summarize each message for the user
3. If any are delegated tasks, ask the user if they want you to work on them

### "Coordinate with the other instance on this feature"
1. list_peers → find the peer, note their cwd
2. send_message → describe what you're working on and propose a division of labor
3. Start a background listener to hear their response
4. When they reply, continue the coordination

## Important notes
- Peer IDs are UUIDs — always use list_peers to discover them, never guess.
- If send_message or delegate_task fails with "Peer not found", the peer may have shut down. Re-run list_peers to refresh.
- Messages and tasks are ephemeral (in-memory only) — they don't persist across server restarts.
- All communication stays local to this machine via Unix domain sockets.`;

export function createMcpServer(
  peerId: string,
  peerName: string,
  messageStore: MessageStore,
  taskStore: TaskStore,
  registryEntry: PeerRegistryEntry
): McpServer {
  const instructions = SERVER_INSTRUCTIONS
    .replace('{peerName}', peerName)
    .replace('{peerId}', peerId);

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
  registerPrompts(server, peerId, peerName);

  return server;
}
