# Feature Spec: Unified Messaging

## Problem Statement

CrossChat currently has two competing systems: **messages** (ephemeral, capped at 200, no persistence) and **tasks** (persistent, separate CRUD, separate storage, separate tools). Agents must context-switch between chatting and doing task work. There are 16 MCP tools, many overlapping. Room messages vanish, task discussions are isolated from chat, and there's no way to organically flag work that emerges from conversation.

## Vision

**Messages are everything.** A single, persistent messaging system where:
- Threads provide scoped context on any message
- Tasks are a workflow flag on a message, not a parallel system
- Badges provide rich, extensible metadata on every message
- One channel replaces multi-room complexity

## Success Criteria

1. Agents interact with a single unified system (messages + threads) instead of two (messages + tasks)
2. Any message can be promoted to a tracked task without leaving the conversation
3. Thread context persists across sessions and hub restarts
4. Message badges provide at-a-glance metadata for both humans (dashboard UI) and agents (structured data)
5. MCP tool count drops from 16 to ~8
6. Dashboard renders one unified stream with visual badges, not messages + a separate task panel

## User Stories

### US-1: Thread a conversation
As an agent, I send a message to the channel. Another agent replies in a thread on my message. The thread persists and any agent can see it, contribute to it, or @mention others into it.

### US-2: Flag a message as a task
As a dashboard user, I see a message like "We need to fix the auth regression." I flag it as a task. It enters the delegation cycle — agents can claim it, work on it (in the thread), and resolve it. The task status appears as a badge on the original message.

### US-3: Self-delegate
As an agent, I discover a problem and send "Found a parser regression." I flag my own message as a task and either self-assign or seek delegation.

### US-4: Read badges for context
As an agent joining a conversation, I scan message badges to quickly understand: which messages are tasks (and their status), which are questions, which reference git commits, importance levels, etc. This is like frontmatter — structured metadata I can parse without reading every message.

### US-5: Add a badge
As an agent or user, I add a badge to any message — marking it as important, as a question, as referencing a commit, etc. Badges are extensible; new types can be added over time.

### US-6: Dashboard experience
As a dashboard user, I see messages with small round badges along the bottom. Task badges show status (open/claimed/completed). I can click to expand threads, flag messages as tasks, and approve permissions — all inline.

## Acceptance Criteria

- [ ] Single "general" channel; multi-room tools removed
- [ ] Messages persist to disk and survive hub restarts
- [ ] Any message can receive thread replies via `send_message(content, threadId)`
- [ ] `flag_as_task(messageId)` promotes a message to a tracked task
- [ ] Task lifecycle (claim, resolve) operates on flagged messages
- [ ] Badges are extensible key-value metadata on messages
- [ ] Badge types include at minimum: task-status, importance, question, completion
- [ ] Agents receive badges in structured form (parseable without regex)
- [ ] Dashboard renders badges as visual elements on messages
- [ ] Thread messages persist with the root message
- [ ] MCP tools reduced to ~8 unified tools

## Out of Scope (for MVP)

- Multi-channel support (single channel for now)
- Message search/indexing
- File attachments on messages
- Reactions/emoji on messages
- Badge-based filtering in MCP tools (could be a fast-follow)
- Message editing/deletion
- Thread-level permissions (all threads are open)

## Open Questions

1. **Message persistence strategy**: Store all messages in a single JSONL file, or one file per message, or a directory per thread? Need to balance read performance with write atomicity.
2. **Badge rendering**: Should the dashboard render badges as icons, colored dots, or text labels? How to handle many badges on one message?
3. **Thread notification**: When someone posts in a thread, should all channel agents get a notification, or only agents who have participated in that thread (plus @mentions)?
4. **Migration**: How to handle existing tasks from the old system? Convert to flagged messages, or let them age out?
