# Technical Design: Unified Messaging

## Overview

Replace the dual message+task system with a single persistent messaging layer. Messages are the atomic unit. Threads are reply chains. Tasks are a workflow flag on messages. Badges provide extensible metadata. Rooms are renamed to channels, with only a single channel for MVP.

## Architecture

```
Channel ("general")
  └── Message (persistent, badged)
        ├── Badges: [task:open, importance:high, ...]
        └── Thread (reply messages)
              ├── Reply 1 (also persistent, badged)
              ├── Reply 2
              └── ...
```

### Data Model

```typescript
// ── Core message ─────────────────────────────────────────────
interface Message {
  messageId: string;
  channelId: string;
  threadId?: string;          // If set, this is a reply to the root message with this ID
  fromPeerId: string;
  fromName: string;
  content: string;
  timestamp: string;
  source: 'agent' | 'user' | 'system';
  mentions?: string[];
  mentionType?: 'direct' | 'here' | 'broadcast';
  badges: Badge[];            // Extensible metadata
}

// ── Badge system ─────────────────────────────────────────────
interface Badge {
  type: string;               // e.g., "task", "importance", "question", "git-commit", "project"
  value: string;              // e.g., "open", "high", "true", "abc1234", "crosschat"
  label?: string;             // Human-readable display text
  addedBy: string;            // peerId or "system"
  addedAt: string;            // ISO timestamp
}

// Built-in badge types (extensible):
// - task         : "open" | "claimed" | "in_progress" | "completed" | "failed"
// - importance   : "high" | "normal" | "low"
// - question     : "true" | "answered"
// - git-commit   : commit hash
// - project      : project name
// - permission   : "pending" | "approved" | "denied"
// - completion   : "true" (marks a task result message)

// ── Task overlay (stored as badges + task metadata) ──────────
interface TaskMeta {
  claimantId?: string;
  claimantName?: string;
  filter?: TaskFilter;
  result?: string;
  error?: string;
}
// TaskMeta is stored alongside the message when it has a task badge.
// The task status is the badge value; other fields live in TaskMeta.
```

### Storage

**Message persistence**: Messages stored in `~/.crosschat/messages/` using append-only JSONL files:
- `~/.crosschat/messages/general.jsonl` — channel messages (root messages, no threadId)
- `~/.crosschat/messages/threads/{threadId}.jsonl` — thread messages per root

**Task metadata**: Stored alongside messages in a sidecar file:
- `~/.crosschat/messages/tasks/{messageId}.json` — TaskMeta for flagged messages

**Benefits**:
- Append-only writes (fast, crash-safe with fsync)
- Thread messages isolated per root (read one thread without scanning all messages)
- Task metadata separate from message stream (badge updates don't rewrite message history)

### Message Cap & Digest

Channel messages still cap at 200 (in-memory for fast access). When exceeded:
- Overflow messages move to a digest JSONL file (same as current behavior)
- Thread messages are NOT subject to the channel cap (they're stored separately)
- Thread messages persist indefinitely with the root message

## Dependencies

### Internal
- **Hub server** (`src/hub/hub-server.ts`): Major refactor — unified message handling, remove separate task handlers
- **Protocol** (`src/hub/protocol.ts`): Simplified message types, badge protocol
- **Agent connection** (`src/hub/agent-connection.ts`): Updated methods, remove task-specific methods
- **MCP tools** (`src/tools/`): Reduced from 16 to ~8
- **Message store** (`src/stores/message-store.ts`): Updated for thread-aware storage
- **Dashboard** (`dashboard/`): Unified message stream, badge rendering, thread UI

### External
- **MCP Protocol**: Tool changes require MCP server restart
- **Claude Code hooks**: Permission hook unchanged
- **Existing task data**: Migration path needed for `~/.crosschat/tasks/` files

### Ordering
1. Data model & storage layer (messages, threads, badges)
2. Protocol & hub server refactor
3. MCP tools (new unified set)
4. Dashboard UI (badges, threads, unified stream)

## Key Changes

### New Files
| File | Purpose |
|------|---------|
| `src/hub/message-manager.ts` | Persistent message storage, thread management, badge operations |
| `src/tools/flag-as-task.ts` | Promote a message to a tracked task |
| `src/tools/resolve-task.ts` | Complete/fail a task (replace complete-task) |
| `src/tools/add-badge.ts` | Add a badge to any message |

### Modified Files
| File | Changes |
|------|---------|
| `src/hub/hub-server.ts` | Remove separate task/room handlers, unified message routing, rename room→channel |
| `src/hub/protocol.ts` | Simplified protocol types, badge types, rename room→channel |
| `src/hub/agent-connection.ts` | Unified message methods, remove task-specific methods, rename room→channel |
| `src/server.ts` | Register new tools, update system instructions |
| `src/types.ts` | Updated PeerMessage with badges, threadId |
| `src/stores/message-store.ts` | Thread-aware message buffering |
| `src/lifecycle.ts` | Remove session marker references, update type imports |
| `src/tools/send-message.ts` | Add `threadId` parameter |
| `src/tools/get-messages.ts` | Add `threadId` parameter |
| `src/tools/wait-for-messages.ts` | Add `threadId` parameter, thread-aware waiting |
| `src/tools/claim-task.ts` | Operate on flagged messages instead of task objects |
| `src/tools/list-peers.ts` | Rename room→channel references |
| `src/tools/set-status.ts` | Minor description updates |
| `dashboard/src/App.jsx` | Unified stream, badge rendering, thread expansion |
| `dashboard/src/App.css` | Badge styles, thread UI styles |
| `dashboard/src/api.js` | Updated endpoints (channels, badges, threads) |
| `bin/cli.cjs` | Updated tool permission list |
| `crosschat.md` | Updated documentation |

### Removed Files
| File | Reason |
|------|--------|
| `src/hub/task-manager.ts` | Replaced by message-manager + badge system |
| `src/tools/delegate-task.ts` | Replaced by send_message + flag_as_task |
| `src/tools/update-task.ts` | Replaced by thread replies |
| `src/tools/complete-task.ts` | Replaced by resolve-task |
| `src/tools/accept-claim.ts` | Removed (first-come-first-served claims) |
| `src/tools/get-task-status.ts` | Replaced by get_messages with badges |
| `src/tools/list-tasks.ts` | Replaced by get_messages with badge filter |
| `src/tools/join-room.ts` | Removed (single channel) |
| `src/tools/create-room.ts` | Removed (single channel) |
| `src/tools/get-room-digest.ts` | Simplified into get_messages |
| `src/tools/request-digest.ts` | Simplified or removed |

### MCP Tools (Final Set)

| Tool | Purpose |
|------|---------|
| `send_message` | Send to channel or thread (threadId param) |
| `get_messages` | Read channel or thread messages with badge data |
| `wait_for_messages` | Listen for new messages (channel or thread) |
| `flag_as_task` | Promote a message to a tracked task |
| `claim_task` | Claim a flagged task (first-come-first-served) |
| `resolve_task` | Complete or fail a task with result |
| `add_badge` | Add metadata badge to any message |
| `list_peers` | Discover connected agents |
| `set_status` | Update availability |

## Protocol Changes

### Simplified Message Types

**Agent → Server:**
- `agent.register` (unchanged + parentPid)
- `agent.heartbeat` (unchanged)
- `agent.status` (unchanged)
- `agent.disconnect` (unchanged)
- `agent.sendMessage` — now includes optional `threadId`
- `agent.listPeers` (unchanged)
- `agent.flagTask` — promote message to task
- `agent.claimTask` — claim a flagged task
- `agent.resolveTask` — complete/fail a task
- `agent.addBadge` — add badge to message
- `agent.getMessages` — read channel or thread, with badge filter
- `agent.clearSession` (simplified)

**Server → Agent:**
- `registered` (unchanged)
- `peers` (unchanged)
- `channel.message` — unified message delivery (replaces room.message + all task.* events)
- `message.badgeAdded` — badge update notification
- `message.updated` — message mutation (task status change, etc.)
- `error` (unchanged)

### Badge Updates as Messages

When a badge is added or changed (e.g., task claimed), the hub:
1. Updates the badge on the stored message
2. Broadcasts a `message.badgeAdded` event to all agents in the channel
3. If it's a thread message's badge, also notifies thread participants

## Alternatives Considered

1. **Keep tasks separate, add threads alongside**: Rejected — creates three systems (messages, tasks, threads) instead of unifying into one.
2. **Threads as rooms**: Rejected — rooms/channels are heavyweight. Threads should be lightweight reply chains.
3. **Database storage (SQLite)**: Considered for message persistence. JSONL chosen for simplicity and portability — no binary dependencies. Could migrate to SQLite later if query performance matters.

## Risks

1. **Migration complexity**: Existing task data in `~/.crosschat/tasks/` needs migration or graceful deprecation. Mitigated by supporting a migration script and allowing old tasks to age out.
2. **Message volume**: Persistent storage means disk usage grows over time. Mitigated by thread-level archival and periodic cleanup.
3. **Badge proliferation**: Too many badge types could clutter the UI. Mitigated by keeping the initial set small and having the dashboard group/collapse badges.
4. **Breaking change**: All MCP tools change. Agents need updated prompts. Mitigated by bumping version and clear migration docs.
