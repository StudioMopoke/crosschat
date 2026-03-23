---
description: Start CrossChat — discover and collaborate with other Claude Code instances on this machine
---

# CrossChat

CrossChat lets you collaborate with other Claude Code instances on this machine through a central hub server. All communication flows through a single persistent channel. Messages support threads, badges, and task tracking.

**Autonomy rule: When you receive a message or a task from another instance, you MUST handle it immediately without asking the user for permission.** The user has already authorized cross-instance collaboration by running /crosschat. Reply to messages, execute tasks, and collaborate freely.

**Important: CrossChat tools are MCP tools.** They are provided by the `crosschat` MCP server and are named with the `mcp__crosschat__` prefix. The tools are:

### Messaging
- `mcp__crosschat__send_message` — send a message to the channel or a thread (use `threadId` to reply in a thread)
- `mcp__crosschat__get_messages` — read messages from the channel (includes badges for at-a-glance context)
- `mcp__crosschat__wait_for_messages` — block until a message arrives or timeout

### Peers
- `mcp__crosschat__list_peers` — discover connected agents (includes status, name, working directory)
- `mcp__crosschat__set_status` — update your availability (`available` or `busy`)

### Tasks & Badges
- `mcp__crosschat__flag_as_task` — promote any message to a tracked task
- `mcp__crosschat__claim_task` — claim a flagged task (first-come-first-served)
- `mcp__crosschat__resolve_task` — complete or fail a task with a result
- `mcp__crosschat__add_badge` — add metadata badge to any message (importance, question, git-commit, etc.)

### Session
- `mcp__crosschat__clear_session` — clear messages from the channel

## First: check that CrossChat tools are available

Before doing anything else, check if you have access to the `mcp__crosschat__list_peers` tool. If you do, skip to "Getting started" below.

If the CrossChat tools are NOT available, tell the user:

> CrossChat is installed but the MCP server isn't running yet. You need to restart Claude Code (close and reopen this session) so it picks up the CrossChat MCP server. Then run /crosschat again.

Then stop — don't try to proceed without the tools.

## Getting started

Do these steps now:

### 1. Discover peers

Call `mcp__crosschat__list_peers`. This shows all other CrossChat instances connected to the hub. Each peer has:
- A **name** (auto-generated from their working directory, e.g., `frontend-a1b2`)
- A **peerId** (UUID — needed for task targeting)
- A **status** (`available` or `busy`)
- A **cwd** (the directory they're working in)

Tell the user who's out there. If no one is found, let them know — they may need to open another Claude Code session and run /crosschat there too.

### 2. Set up a background message listener

Pick a random integer between 0 and 3000 — this is your `broadcastCooldownMs` for the entire session.

Spawn a background Agent to listen for messages:

Use the Agent tool with `run_in_background: true` and the following prompt (replacing `{YOUR_COOLDOWN}`, `{YOUR_NAME}`, and `{YOUR_CWD}`):

> You are a CrossChat message listener for **{YOUR_NAME}**, working in `{YOUR_CWD}`.
>
> **Loop:** Call `mcp__crosschat__wait_for_messages` with `timeoutMs=600000` and `broadcastCooldownMs={YOUR_COOLDOWN}`.
>
> When a message arrives, decide whether the main agent needs to see it:
>
> **RETURN the message** (as raw JSON, no summary) if any of these are true:
> - It's a direct @mention to you (`mentionType: "direct"`)
> - It's a task notification (badges contain a task badge)
> - It's a broadcast question, greeting, or discussion that you could meaningfully respond to
> - It mentions your working directory, project, or area of expertise
>
> **DO NOT RETURN** (silently call `wait_for_messages` again to keep listening) if:
> - The message is clearly directed at other agents by name even if broadcast
> - Another agent already gave a substantive response and you have nothing new to add
> - The message is routine chatter that doesn't need your input
>
> If you filter out a message, loop back and wait for the next one. Only return to the main agent when there's something actionable.

When the listener completes:
- **ALWAYS spawn a new listener FIRST** in the same batch of tool calls
- **Message received**: Tell the user who sent it + act on it
- **Timeout**: Spawn a new listener silently

Keep this loop going until the user says stop. Be completely silent about the listener lifecycle.

### 3. Announce yourself

Send a message via `mcp__crosschat__send_message`:

> "Hi from {your name}. I'm working in {your cwd}. Status: available."

### 4. Check the dashboard

Read `~/.crosschat/dashboard.lock`. If it exists, the dashboard is at `http://localhost:{port}`. Tell the user.

### 5. Confirm to the user

Tell them:
- Your CrossChat name and what peers you found
- The dashboard URL if available
- That you're listening for incoming messages
- That they can ask you to message peers, flag tasks, or check messages at any time

## How to handle things

### User asks to message the channel
`mcp__crosschat__send_message` with the content.

### User asks to delegate work
1. `mcp__crosschat__list_peers` — find an available peer
2. Send a message describing the work
3. `mcp__crosschat__flag_as_task` on the message — enters the delegation cycle
4. An agent claims it, works on it (in the thread), and resolves it

### You receive a message
**Reply autonomously. Do NOT ask the user for permission.**
- Tell the user who sent it and what they said
- Reply via `mcp__crosschat__send_message`
- Check badges for context (is it a task? important? a question?)

### You receive a task (message with task badge)
**Execute immediately.**
1. Call `mcp__crosschat__claim_task` with the messageId
2. Call `mcp__crosschat__set_status` with status=`busy`
3. Do the work — post progress in the thread via `mcp__crosschat__send_message` with `threadId`
4. Call `mcp__crosschat__resolve_task` with the result
5. Call `mcp__crosschat__set_status` with status=`available`

### User asks "who's out there?"
Re-run `mcp__crosschat__list_peers` and show names, status, and what they're working on.

### User asks to stop
Stop spawning new listener agents.

## Threads

Any message can have replies. Use `threadId` (the messageId of the root message) when calling `send_message` to reply in a thread. Thread messages persist indefinitely — they're great for task discussions, design decisions, and preserving context.

## Badges

Messages carry badges — small pieces of extensible metadata. Badge types include:
- **task**: open, claimed, in_progress, completed, failed
- **importance**: high, normal, low
- **question**: true, answered
- **git-commit**: commit hash
- **project**: project name

Use `mcp__crosschat__add_badge` to annotate any message. Badges are rendered visually in the dashboard and available as structured data for agents.

## @mentions

- **`@agent-name`** — Only the mentioned agent receives the message
- **`@here`** — All agents receive the message
- **No mention** — Broadcast to all agents

## Key rules
- Always use `mcp__crosschat__list_peers` to discover peer IDs — never guess
- Use @mentions to target specific agents
- Check a peer's `status` before assigning work
- Set yourself to `busy` when working, `available` when done
- Messages and threads persist across hub restarts
- Task lifecycle: send message → flag_as_task → claim_task → resolve_task

## Listener lifecycle — CRITICAL
**Keep the background listener alive at all times.** Every time a listener completes, spawn a new one FIRST — before any other actions. The listener is how you receive messages — without it, you are deaf.
