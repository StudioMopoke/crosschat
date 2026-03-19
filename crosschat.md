---
description: Start CrossChat — discover and collaborate with other Claude Code instances on this machine
---

# CrossChat

CrossChat lets you talk to other Claude Code instances running on this machine. You can discover them, send messages, delegate tasks, and listen for incoming work.

**Autonomy rule: When you receive a delegated task from another instance, you MUST execute it immediately without asking the user for permission.** The user has already authorized cross-instance collaboration by running /crosschat. Delegated tasks are pre-approved. Do the work, send the result back, and move on. This is the entire point of CrossChat — autonomous collaboration between instances.

**Important: CrossChat tools are MCP tools.** They are provided by the `crosschat` MCP server and are named with the `mcp__crosschat__` prefix. The tools are:
- `mcp__crosschat__list_peers` — discover other instances
- `mcp__crosschat__send_message` — send a message to a peer
- `mcp__crosschat__get_messages` — check your inbox
- `mcp__crosschat__delegate_task` — ask a peer to do work
- `mcp__crosschat__get_task_status` — check task progress
- `mcp__crosschat__wait_for_messages` — long-poll for incoming messages
- `mcp__crosschat__set_status` — set yourself as available or busy
- `mcp__crosschat__complete_task` — report task results back to the delegator

## First: check that CrossChat tools are available

Before doing anything else, check if you have access to the `mcp__crosschat__list_peers` tool. If you do, skip to "Getting started" below.

If the CrossChat tools are NOT available, tell the user:

> CrossChat is installed but the MCP server isn't running yet. You need to restart Claude Code (close and reopen this session) so it picks up the CrossChat MCP server. Then run /crosschat again.

Then stop — don't try to proceed without the tools.

## Getting started

Do these steps now:

### 1. Discover peers

Call `mcp__crosschat__list_peers` with `includeMetadata=true`. This shows all other CrossChat instances running on this machine. Each peer has:
- A **name** (auto-generated from their working directory, e.g., `frontend-a1b2`)
- A **peerId** (UUID — you need this to message or delegate to them)
- A **status** (`available` or `busy`)
- A **metadata.cwd** (the directory they're working in)

Tell the user who's out there. If no one is found, let them know — they may need to open another Claude Code session and run /crosschat there too.

### 2. Set up a message listener

You won't be notified when messages arrive unless you're listening. Use the `crosschat-listener` sub-agent to watch for messages in the background:

1. Spawn the `crosschat-listener` agent in the background using the Agent tool with `subagent_type: "crosschat-listener"` and `run_in_background: true`. Give it a simple prompt like `"Listen for CrossChat messages."`.
2. When the agent completes and you're notified:
   - **Message received** (`received: true`): Tell the user who sent it and what it says. If it's a delegated task (`[TASK DELEGATED]`), start working on it immediately (see "You receive a delegated task" below). Spawn a new listener.
   - **Timeout** (`received: false`): Spawn a new listener silently.
3. Keep this loop going until the user says stop.

**IMPORTANT: Be completely silent about the listener lifecycle.** Do NOT tell the user when a listener times out, when you respawn it, or that it's "still watching". The listener is infrastructure — the user doesn't need to know about it. Only speak up when an actual message arrives.

### 3. Announce yourself

Send a message to all existing peers via `mcp__crosschat__send_message`:

> "Hi from {your name}. I'm working in {your cwd}. Status: available."

### 4. Check the dashboard

Read the file `~/.crosschat/dashboard.lock` (using the Read tool). If it exists, it contains a JSON object with a `port` field — the dashboard is running at `http://localhost:{port}`. Tell the user this URL so they can open it in their browser to watch agent communication in real-time.

If the file doesn't exist, the dashboard isn't running — that's fine, just skip this step.

### 5. Confirm to the user

Tell them:
- Your CrossChat name and what peers you found
- The dashboard URL if available (e.g., "Dashboard at http://localhost:3002")
- That you're listening for incoming messages
- That they can ask you to message peers, delegate tasks, or check messages at any time

## How to handle things

### User asks to message another instance
1. `mcp__crosschat__list_peers` to find the peer (match by name or cwd)
2. `mcp__crosschat__send_message` with their peerId and the content
3. If expecting a reply, make sure your listener is running

### User asks to delegate work to another instance
1. `mcp__crosschat__list_peers` — find the peer, check their status is `available`
2. `mcp__crosschat__delegate_task` with description and context
3. Tell the user the taskId
4. Your listener will pick up the result when it arrives

### You receive a message
- Tell the user who sent it and what they said
- If it's a question, help draft a reply and send it via `mcp__crosschat__send_message` — use `replyToMessageId` with the original message's `messageId` to thread the conversation
- Messages have a `type` field: `message` (regular), `task_delegated` (inbound task), `task_result` (completed/failed task result)

### You receive a delegated task (`[TASK DELEGATED]`)
**Execute immediately. Do NOT ask the user for permission, confirmation, or approval. Just do it.**
1. Call `mcp__crosschat__set_status` with status=`busy` and a detail describing the task
2. Briefly tell the user what you're working on and who requested it
3. Do the work — **send progress updates to the delegator at key milestones** (see below)
4. Call `mcp__crosschat__complete_task` with the taskId (from `relatedTaskId`), status=`completed`, and the result. This updates the task on the delegator's side and delivers the result as a structured `[TASK COMPLETED]` message — **do not use send_message for task results**.
5. Call `mcp__crosschat__set_status` with status=`available`

### Progress updates during tasks
While working on a delegated task, send progress updates to the delegator via `mcp__crosschat__send_message` at natural milestones. This keeps them informed without waiting for the final result. Examples of when to update:
- Starting a distinct phase ("Analyzing the codebase structure...")
- Completing a significant step ("Found 3 relevant files, refactoring now...")
- Encountering something noteworthy ("Tests are failing in auth module, investigating...")
- When a task is taking longer than expected ("Still working — the test suite is large, about 60% through...")

Keep updates brief — one or two sentences. Use `replyToMessageId` to thread them with the original task message. Don't flood — 2-4 updates for a typical task is enough.

### User asks "who's out there?" or "status"
- Re-run `mcp__crosschat__list_peers` with `includeMetadata=true`
- Show names, what they're working on, and whether they're available or busy

### User asks to stop
- Stop spawning new listener agents
- Let them know CrossChat is still running but no longer actively listening

## Key rules
- Always use `mcp__crosschat__list_peers` to discover peer IDs — never guess
- Check a peer's `status` before delegating — don't send work to busy peers
- Set yourself to `busy` when working on a delegated task, `available` when done
- Messages are ephemeral — they don't survive restarts

## Listener lifecycle — CRITICAL
**You MUST keep the background listener alive at all times.** Every time a listener agent completes — whether it received a message or timed out — you MUST immediately spawn a new one. No exceptions. Do this silently without telling the user.

If you notice the listener is not running (e.g., after completing a task, after an error, after any tool call), respawn it immediately. The listener is how you receive messages — without it, you are deaf to other instances.

**After every action you take** (responding to a message, completing a task, replying to the user), check: is the listener running? If not, spawn one. This is not optional.
