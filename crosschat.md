---
description: Start CrossChat — discover and collaborate with other Claude Code instances on this machine
---

# CrossChat

CrossChat lets you talk to other Claude Code instances running on this machine. You can discover them, send messages, delegate tasks, and listen for incoming work.

## First: check that CrossChat tools are available

Before doing anything else, check if you have access to the `list_peers` tool. If you do, skip to "Getting started" below.

If the CrossChat tools (`list_peers`, `send_message`, `get_messages`, `delegate_task`, `get_task_status`, `wait_for_messages`, `set_status`) are NOT available as MCP tools in this session, tell the user:

> CrossChat tools are not available in this session. This means the CrossChat MCP server isn't running.
>
> To fix this:
> 1. Make sure CrossChat is installed: run `npx @studiomopoke/crosschat install` in your terminal
> 2. Restart Claude Code (close and reopen this session)
> 3. Run /crosschat again
>
> The MCP server starts automatically when Claude Code launches — but only if the config is in place and Claude Code has been restarted since installing.

Then stop — don't try to proceed without the tools.

## Getting started

Do these steps now:

### 1. Discover peers

Call `list_peers` with `includeMetadata=true`. This shows all other CrossChat instances running on this machine. Each peer has:
- A **name** (auto-generated from their working directory, e.g., `frontend-a1b2`)
- A **peerId** (UUID — you need this to message or delegate to them)
- A **status** (`available` or `busy`)
- A **metadata.cwd** (the directory they're working in)

Tell the user who's out there. If no one is found, let them know — they may need to open another Claude Code session and run /crosschat there too.

### 2. Set up a message listener

You won't be notified when messages arrive unless you're listening. Set up a background listener:

1. Spawn a background sub-agent (use Haiku — cheapest model).
2. The sub-agent's only job: `Call the wait_for_messages CrossChat tool with timeoutMs=60000. Return the full result as-is.`
3. When the sub-agent completes:
   - **Message received**: Tell the user who sent it and what it says. If it's a delegated task (`[TASK DELEGATED]`), describe the task and ask if they want you to do it. Spawn a new listener.
   - **Timeout**: Spawn a new listener silently. Don't mention timeouts.
4. Keep this loop going until the user says stop.

### 3. Announce yourself

Send a message to all existing peers via `send_message`:

> "Hi from {your name}. I'm working in {your cwd}. Status: available."

### 4. Confirm to the user

Tell them:
- Your CrossChat name and what peers you found
- That you're listening for incoming messages
- That they can ask you to message peers, delegate tasks, or check messages at any time

## How to handle things

### User asks to message another instance
1. `list_peers` to find the peer (match by name or cwd)
2. `send_message` with their peerId and the content
3. If expecting a reply, make sure your listener is running

### User asks to delegate work to another instance
1. `list_peers` — find the peer, check their status is `available`
2. `delegate_task` with description and context
3. Tell the user the taskId
4. Your listener will pick up the result when it arrives

### You receive a message
- Tell the user who sent it and what they said
- If it's a question, help draft a reply and send it via `send_message`

### You receive a delegated task (`[TASK DELEGATED]`)
1. Tell the user what was requested and by whom
2. Call `set_status` with status=`busy` and a detail describing the task
3. Ask the user if they want to proceed
4. If yes, do the work
5. Send the result back via `send_message` to the sender
6. Call `set_status` with status=`available` — this notifies the sender you're done

### User asks "who's out there?" or "status"
- Re-run `list_peers` with `includeMetadata=true`
- Show names, what they're working on, and whether they're available or busy

### User asks to stop
- Stop spawning new listener agents
- Let them know CrossChat is still running but no longer actively listening

## Key rules
- Always use `list_peers` to discover peer IDs — never guess
- Check a peer's `status` before delegating — don't send work to busy peers
- Set yourself to `busy` when working on a delegated task, `available` when done
- Keep the background listener running at all times unless told to stop
- Messages are ephemeral — they don't survive restarts
