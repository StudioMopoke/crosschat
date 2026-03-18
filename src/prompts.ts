import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer, peerId: string, peerName: string): void {
  // === Primary entry point ===

  server.prompt(
    'crosschat',
    'Start a CrossChat collaboration session. This is the main entry point — use it to begin collaborating with other Claude Code instances.',
    {
      role: z.enum(['orchestrator', 'peer']).optional().describe('Your role: "orchestrator" (direct and delegate work) or "peer" (available for tasks). If omitted, the user is asked.'),
    },
    (args) => {
      if (args.role) {
        return {
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: args.role === 'orchestrator'
                  ? buildOrchestratorPrompt(peerName, peerId)
                  : buildPeerPrompt(peerName, peerId),
              },
            },
          ],
        };
      }

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `You have CrossChat enabled — this lets you collaborate with other Claude Code instances on this machine.

Your identity: **${peerName}** (peer ID: ${peerId})

Before we begin, I need to know how you'd like to collaborate. There are two roles:

**Orchestrator** — You direct the work. You'll discover other instances, delegate tasks to them, coordinate their efforts, and collect results. Choose this if you want to be the "lead" that breaks a problem into pieces and farms them out.

**Peer** — You're a worker, available for collaboration. You'll set up a listener for incoming messages and tasks, execute work that other instances delegate to you, and report results back. Choose this if you want this instance to be available for others to send work to.

Ask me which role I'd like, then set up accordingly. Keep the explanation brief — just the two options and what they mean.`,
            },
          },
        ],
      };
    }
  );

  // === Supporting prompts ===

  server.prompt(
    'check-inbox',
    'Check for new messages and delegated tasks from other CrossChat peers. Use this when you want to see if anyone has sent you messages or assigned you work.',
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
    'Find all active CrossChat instances and describe who they are and what they\'re working on.',
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Use list_peers with includeMetadata=true to discover all active CrossChat instances. For each peer, tell me:
- Their name and peer ID
- What directory they're working in (from metadata.cwd)
- How long they've been running (from registeredAt)
If no peers are found, let me know I'm the only active instance.`,
          },
        },
      ],
    })
  );

  server.prompt(
    'send-to-peer',
    'Compose and send a message to another CrossChat peer. Discovers peers first if needed.',
    {
      peerName: z.string().optional().describe('Name or partial name of the peer to message. If omitted, lists peers first.'),
      message: z.string().optional().describe('The message to send. If omitted, asks what to say.'),
    },
    (args) => {
      const parts: string[] = [];
      if (args.peerName && args.message) {
        parts.push(
          `Find a peer whose name contains "${args.peerName}" using list_peers, then send them this message using send_message: "${args.message}". If multiple peers match, ask me which one. If none match, show me the available peers.`
        );
      } else if (args.peerName) {
        parts.push(
          `Find a peer whose name contains "${args.peerName}" using list_peers, then ask me what message I'd like to send them.`
        );
      } else {
        parts.push(
          `Use list_peers to show me all available peers, then ask me which one I'd like to message and what to say.`
        );
      }

      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: parts.join('\n') },
          },
        ],
      };
    }
  );

  server.prompt(
    'delegate-work',
    'Delegate a task to another CrossChat peer. Walks you through selecting a peer and describing the work.',
    {
      peerName: z.string().optional().describe('Name or partial name of the peer to delegate to'),
      task: z.string().optional().describe('Description of the task to delegate'),
    },
    (args) => {
      const parts: string[] = [];
      if (args.peerName && args.task) {
        parts.push(
          `Find a peer whose name contains "${args.peerName}" using list_peers (with includeMetadata=true so we can provide context about their environment), then delegate this task to them using delegate_task: "${args.task}". Report back the taskId so I can track it.`
        );
      } else {
        parts.push(
          `Use list_peers with includeMetadata=true to show me all available peers and what they're working on. Then help me delegate a task:`
        );
        if (args.peerName) {
          parts.push(`- Target peer: name containing "${args.peerName}"`);
        } else {
          parts.push(`- Ask me which peer should handle the task`);
        }
        if (args.task) {
          parts.push(`- Task: ${args.task}`);
        } else {
          parts.push(`- Ask me to describe the task`);
        }
      }

      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: parts.join('\n') },
          },
        ],
      };
    }
  );

  server.prompt(
    'start-listening',
    'Set up a background listener that watches for incoming CrossChat messages. Uses the background agent pattern with wait_for_messages.',
    {
      timeoutMs: z.string().optional().describe('How long each wait cycle should block, in milliseconds (default: 60000)'),
    },
    (args) => {
      const timeout = args.timeoutMs || '60000';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Set up a background CrossChat message listener using the background agent pattern:

1. Spawn a lightweight background sub-agent (use the cheapest model available, e.g., Haiku).
2. Give it this prompt: "Call the wait_for_messages CrossChat tool with timeoutMs=${timeout}. Return the full result as-is."
3. When the sub-agent completes and returns a result:
   - If it received a message (received: true): tell me who sent it and what it says. If it's a delegated task (content starts with [TASK DELEGATED]), describe the task and ask if I want you to work on it. Then spawn a new listener.
   - If it timed out (received: false): spawn a new listener silently — don't tell me about timeouts unless I ask.
4. Keep this loop going until I say stop.

Confirm that the listener is active, then continue with whatever else I ask you to do.`,
            },
          },
        ],
      };
    }
  );

  server.prompt(
    'my-identity',
    'Show your CrossChat identity — your peer ID, name, and connection info.',
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Report your CrossChat identity. You are:
- Name: ${peerName}
- Peer ID: ${peerId}
- PID: ${process.pid}
- Working directory: ${process.env.CROSSCHAT_CWD || process.cwd()}

Tell me this info and explain that other peers can message me using my peer ID.`,
          },
        },
      ],
    })
  );
}

function buildOrchestratorPrompt(peerName: string, peerId: string): string {
  return `You are now in **Orchestrator** mode for CrossChat.

Your identity: **${peerName}** (${peerId})

## Setup — do these steps now
1. Call \`list_peers\` with \`includeMetadata=true\` to discover any instances already running.
2. If peers are found, send each one an introduction message via \`send_message\`:
   "[ORCHESTRATOR] ${peerName} is online and coordinating. I can see you are working in {their cwd}. If you're available for tasks, let me know what you can help with."
3. Set up a background message listener so you hear when peers respond or new peers announce themselves:
   - Spawn a lightweight background sub-agent (Haiku).
   - The sub-agent calls \`wait_for_messages\` with timeoutMs=60000 and returns the result.
   - When it completes: if a message was received, tell me about it and spawn a new listener. If it timed out, spawn a new listener silently.
4. Tell me who's available and what they're working on. If no peers are found yet, tell me — they may join later and will announce themselves.

## Handling peer announcements
Peers starting in peer mode will send you an announcement like \`[PEER AVAILABLE] ...\`. When you receive one:
- Acknowledge it to me: "New peer available: {name}, working in {cwd}"
- Send them a welcome: "[ORCHESTRATOR] Got it, {name}. I'll send work your way when needed."
- Add them to your mental roster of available workers.

## Handling peer status
- When you call \`list_peers\`, check each peer's **status** field.
- **"available"** — this peer is free and can be delegated work.
- **"busy"** — this peer is already working on something. Check \`statusDetail\` to see what. Check \`orchestratorPeerId\` to see if they're working for you or someone else. **Do not delegate new tasks to busy peers.**
- When a peer finishes work you delegated, you'll receive a \`[PEER AVAILABLE]\` message — they're signaling they're free for more work.

## Your role
- **You direct the work.** When I describe what needs to be done, figure out which peer(s) should handle it and delegate using \`delegate_task\`. **Only delegate to peers with status "available".**
- **Break down complex work** into pieces that can be distributed to different peers based on what they're working on (use their cwd to understand their context).
- **Coordinate results.** When peers report back (or send \`[PEER AVAILABLE]\`), synthesize their results and present a summary to me.
- **Keep me informed.** When you delegate a task, tell me what you sent and to whom. When you hear back, tell me what they said.
- **Handle failures.** If a peer is unreachable or a task times out, let me know and suggest alternatives (retry, delegate to another peer, or do it yourself).

## Commands you should respond to
- "delegate [task] to [peer]" → find the peer (check they're available), delegate the task
- "ask [peer] [question]" → send a message, wait for reply
- "status" → check get_task_status for all active tasks, re-run list_peers to show who's busy/available, check inbox for replies
- "who's available?" → re-run list_peers, filter to status="available"
- "broadcast [message]" → send a message to all known peers

Start now: discover peers, announce yourself, set up your listener, and tell me the state of things.`;
}

function buildPeerPrompt(peerName: string, peerId: string): string {
  return `You are now in **Peer** mode for CrossChat.

Your identity: **${peerName}** (${peerId})
Working directory: ${process.env.CROSSCHAT_CWD || process.cwd()}

## Setup — do these steps now
1. Call \`list_peers\` with \`includeMetadata=true\` to discover other running instances.
2. Announce yourself to all existing peers via \`send_message\`:
   "[PEER AVAILABLE] ${peerName} is online and available for work. Working in: ${process.env.CROSSCHAT_CWD || process.cwd()}"
   This lets orchestrators (and other peers) know you're ready.
3. Set up a background message listener:
   - Spawn a lightweight background sub-agent (Haiku).
   - The sub-agent calls \`wait_for_messages\` with timeoutMs=60000 and returns the result.
   - When it completes: if a message was received, process it (see below). If it timed out, spawn a new listener silently.
4. Confirm to me that you've announced yourself and are listening.

## Handling incoming messages
- **Regular message**: tell me who sent it and what they said. If it's a question, help me draft a reply and send it back via \`send_message\`.
- **Orchestrator introduction** (\`[ORCHESTRATOR] ...\`): tell me an orchestrator is online and available to coordinate. No reply needed unless they ask a question.
- **Delegated task** (content starts with \`[TASK DELEGATED]\`):
  1. Tell me what was requested and who requested it.
  2. Call \`set_status\` with status="busy", a detail describing the task, the relatedTaskId as taskId, and the sender's peerId as orchestratorPeerId. **This prevents other orchestrators from assigning you work while you're busy.**
  3. Ask me if I want you to proceed.
  4. If I say yes, do the work.
  5. Send the result back to the delegating peer via \`send_message\`, referencing the task ID.
  6. Call \`set_status\` with status="available". **This automatically notifies the orchestrator that you're done and free for more work.**
- **Always** spawn a new listener after processing any message.

## Your role
- **You are available for collaboration.** Other instances can discover you, message you, and delegate tasks.
- **Manage your status.** Set yourself to "busy" when working on a task, "available" when done. This is how orchestrators know not to double-book you.
- **Stay available.** Always keep the background listener running.
- **You can also initiate.** If I ask you to message or delegate to another peer, do it — peer mode doesn't mean you can't reach out.

## Commands you should respond to
- "check messages" → call get_messages with unreadOnly=true
- "reply [message]" → send_message back to the last sender
- "who's out there?" → list_peers to see other instances
- "stop listening" → stop spawning new listener agents
- "I'm done" / "finished" → set_status to available, notify orchestrator

Start now: discover peers, announce yourself, set up your listener, and confirm you're ready.`;
}
