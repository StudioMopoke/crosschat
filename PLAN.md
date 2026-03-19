# CrossChat Unified Messaging Redesign

## Overview

Replace the peer-to-peer UDS mesh with a hub-and-spoke model centered on the dashboard server. Agents become WebSocket clients of a central server that manages rooms, peer registration, tasks, and message routing. The file-based peer registry and UDS transport layer are eliminated entirely. Tasks become first-class persistent entities with a claim/accept workflow and disk-backed storage.

## Design Decisions

- **Dashboard server is the central hub** — required, auto-started as a detached process by the first agent that detects it's not running
- **All messaging goes through rooms** — no more direct P2P via UDS
- **Agents connect via WebSocket**, register with the server (no file-based registry)
- **Agents are in one room at a time** (default: "general"); dashboard users can see/post in all rooms
- **Tasks** are created as structured messages in a room with filters (`agentId`, `workingDirReq`, `gitProject`, or open)
- **Task acceptance flow**: agents bid, requester accepts
- **Tasks tracked centrally** on server, independent of rooms, persisted to disk (`~/.crosschat/tasks/`)
- **Tasks are persistent work records** with append-only notes/logs, support markdown blobs
- **Tasks can be archived** when no longer relevant
- **Room messages stay ephemeral**
- `update_task` and `complete_task` support markdown blobs for rich work documentation

## MCP Tools (Target)

| Tool | Description |
|------|-------------|
| `list_peers` | Query connected agents from the hub server |
| `set_status` | Update agent availability status |
| `send_message` | Post a message to the agent's current room |
| `get_messages` | Get messages from the agent's current room |
| `wait_for_messages` | Block until a message arrives in the current room |
| `join_room` | Move agent to a different room (implicitly leaves current) |
| `create_room` | Create a new room on the server |
| `delegate_task` | Create a task in the current room with optional filters |
| `claim_task` | Bid on an open task |
| `accept_claim` | Task creator accepts a bid |
| `update_task` | Append notes/progress to a task (supports markdown blobs) |
| `complete_task` | Mark task done with result (supports markdown blobs) |
| `list_tasks` | List tasks with optional filters (status, room, agent) |
| `get_task_status` | Get full task details including notes history |

---

## Phase 0: Detach the Dashboard Server

**Goal**: The dashboard server runs as a standalone detached process, independent of any agent's lifecycle.

### Steps

**0.1** Create `src/hub/hub-server.ts` — standalone entry point that runs the dashboard server:
- Accept port via `CROSSCHAT_DASHBOARD_PORT` env var or auto-select (port 0)
- Write `~/.crosschat/dashboard.lock` with `{ pid, port, startedAt }`
- Manage its own signal handlers for clean shutdown
- Importable as `hub-server.js` from dist

**0.2** Create `src/hub/hub-main.ts` — minimal wrapper that calls hub-server start and handles uncaught errors (analogous to how `index.ts` wraps `lifecycle.ts`)

**0.3** Add `hub` command to `bin/cli.cjs` and a `hub` script to `package.json` for direct invocation

**0.4** Modify `lifecycle.ts` to auto-start the hub:
- After checking `readDashboardLock()`, if no lock exists, spawn `node dist/hub/hub-main.js` with `child_process.spawn({ detached: true, stdio: 'ignore' })` and call `unref()`
- Poll lock file (up to 3 seconds) for the hub to write its port
- Remove in-process `DashboardServer` instantiation, `MessageBridge`, and `DashboardListener` setup

**0.5** Move/import `DashboardServer` class into the hub. Minimal changes to the class itself at this stage.

### Testing Checkpoint
- Start the hub manually with `node dist/hub/hub-main.js`. Verify lock file, HTTP, WebSocket, and React frontend all work.
- Start an MCP agent. Verify it spawns the hub if not running, discovers port from lock file.
- Kill the agent. Verify the hub stays alive.
- Start a second agent. Verify it finds the existing hub and does not spawn another.

---

## Phase 1: WebSocket Agent Connection and Server-Side Peer Registry

**Goal**: Agents connect to the hub via WebSocket and register themselves. File-based peer registry replaced by in-memory registry on the server.

### WebSocket Protocol (`src/hub/protocol.ts`)

Agent-to-server:
```
{ type: "agent.register", peerId, name, cwd, pid }
{ type: "agent.heartbeat" }
{ type: "agent.status", status, detail, taskId }
{ type: "agent.disconnect" }
```

Server-to-agent:
```
{ type: "registered", peerId, serverVersion }
{ type: "peers", peers: [...] }
{ type: "room.message", roomId, message }
{ type: "task.assigned", task }
{ type: "task.claimed", taskId, claimantId, claimantName }
```

### Steps

**1.1** Define WebSocket protocol types in `src/hub/protocol.ts`

**1.2** Add agent WebSocket handling to the hub server:
- Separate path `/ws/agent` (distinct from `/ws` for dashboard browsers)
- Expect `agent.register` within 5 seconds of connection
- Store peers in `Map<string, ConnectedAgent>`
- Remove peer on WebSocket close
- Ping/pong heartbeat

**1.3** Create `src/hub/agent-connection.ts` — client-side class used by agents:
- Connects to `ws://localhost:{port}/ws/agent`
- Sends `agent.register` on connect
- Reconnection with exponential backoff
- Exposes: `sendMessage(...)`, `setStatus(...)`, `onMessage(callback)`

**1.4** Add `GET /api/peers` endpoint on hub returning connected agents from in-memory registry

**1.5** Update `lifecycle.ts`:
- Replace `UdsServer`, registry write, and socket setup with `AgentConnection`
- Pass `AgentConnection` to `createMcpServer`
- Remove `pruneInterval` and stale entry cleanup

**1.6** Rewrite `tools/list-peers.ts` to query the hub via agent connection

**1.7** Rewrite `tools/set-status.ts` to send status via agent connection

### Testing Checkpoint
- Start hub and two agents. `list_peers` from agent A shows agent B.
- Kill agent B. `list_peers` from agent A no longer shows it.
- Dashboard browser UI shows connected agents from the same data source.

---

## Phase 2: Room-Based Messaging

**Goal**: All messaging goes through rooms. P2P `send_message`, `MessageBridge`, and `DashboardListener` are eliminated.

### Steps

**2.1** Add room membership tracking to the hub:
- Each connected agent has `currentRoom: string` (default: `"general"`)
- Server maintains `Map<string, Set<WebSocket>>` for room membership

**2.2** Implement server-side message routing:
- Message posted to room → broadcast to all WebSocket clients in that room
- Agent clients receive `room.message` events
- Dashboard browser clients receive existing `message` format (backward compatible)

**2.3** Create new MCP tools:
- `src/tools/join-room.ts` — sends `agent.joinRoom` via WebSocket; implicitly leaves current room
- `src/tools/create-room.ts` — creates a room on the server

**2.4** Rewrite `src/tools/send-message.ts`:
- Posts to agent's current room via hub connection
- No `targetPeerId` — just `content` and optional `metadata`

**2.5** Rewrite `src/tools/get-messages.ts`:
- Returns messages received from the current room
- `MessageStore` now stores room messages received via WebSocket

**2.6** Rewrite `src/tools/wait-for-messages.ts`:
- Waits for next room message from WebSocket connection

**2.7** Update `MessageStore` to be room-aware:
- Messages include `roomId` field
- `getAll` filters by agent's current room by default

**2.8** Delete:
- `src/dashboard/message-bridge.ts`
- `src/dashboard/dashboard-listener.ts`
- `src/transport/uds-server.ts`
- `src/transport/uds-client.ts`
- `src/transport/peer-protocol.ts`
- `src/registry/registry.ts`
- `src/registry/cleanup.ts`

### Testing Checkpoint
- Agent A in "general" sends a message. Appears in dashboard browser.
- Dashboard user posts in "general". Agent A receives it via `get_messages`.
- Agent A calls `join_room("dev")`. Messages go to "dev", no longer sees "general".
- Agent B in "general" does not see agent A's "dev" messages.

---

## Phase 3: Task System

**Goal**: Tasks are first-class persistent entities with a claim/accept workflow, structured filters, and markdown blob support.

### Task Types (`src/types.ts`)

```typescript
type TaskStatus = 'open' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'archived';

interface TaskFilter {
  agentId?: string;        // specific agent
  workingDirReq?: string;  // agent must be in this directory
  gitProject?: string;     // agent must be in this git project
}

interface Task {
  taskId: string;
  roomId: string;
  creatorId: string;
  creatorName: string;
  description: string;
  context?: string;
  filter?: TaskFilter;
  status: TaskStatus;
  claimantId?: string;
  claimantName?: string;
  createdAt: string;
  updatedAt: string;
  notes: TaskNote[];       // append-only log
  result?: string;         // markdown blob
}

interface TaskNote {
  noteId: string;
  authorId: string;
  authorName: string;
  content: string;         // markdown
  timestamp: string;
}
```

### Steps

**3.1** Create `src/hub/task-manager.ts` on the server:
- `Map<string, Task>` in memory
- Persists to `~/.crosschat/tasks/{taskId}.json` on every mutation
- Loads existing tasks from disk on startup
- Methods: `create`, `claim`, `acceptClaim`, `update`, `complete`, `archive`, `list`, `get`

**3.2** Implement task WebSocket messages:

Agent-to-server:
```
task.create    — creates a task, posts announcement to room
task.claim     — agent bids on a task
task.accept    — creator accepts a specific claim
task.update    — append a note (markdown blob), optionally update status
task.complete  — mark done with result markdown blob
```

Server-to-agents:
```
task.created        — broadcast to room
task.claimed        — notify creator
task.claimAccepted  — notify claimant
task.updated        — notify creator + claimant
task.completed      — notify creator
```

**3.3** Create/rewrite MCP tools:
- `src/tools/delegate-task.ts` — creates task on server with filters, returns taskId
- `src/tools/claim-task.ts` (new) — agent claims an open task
- `src/tools/accept-claim.ts` (new) — task creator accepts a claim
- `src/tools/update-task.ts` (new) — append notes/logs with markdown blobs
- `src/tools/complete-task.ts` — rewrite, sends `task.complete` with markdown result blob
- `src/tools/get-task-status.ts` — rewrite, queries server
- `src/tools/list-tasks.ts` (new) — list tasks with filters

**3.4** Delete `src/stores/task-store.ts` (replaced by server-side TaskManager)

### Testing Checkpoint
- Agent A creates a task in "general". Persists to `~/.crosschat/tasks/`.
- Agent B sees it via `list_tasks`, calls `claim_task`.
- Agent A sees the claim, calls `accept_claim`.
- Agent B calls `update_task` with markdown progress notes.
- Agent B calls `complete_task` with markdown result. Task file on disk has full history.
- Kill hub, restart. Tasks reloaded from disk.

---

## Phase 4: Polish, Frontend, and Cleanup

**Goal**: Update all surfaces, add task board UI, remove dead code.

### Steps

**4.1** Update `src/server.ts`:
- Register new tools: `join_room`, `create_room`, `claim_task`, `accept_claim`, `update_task`, `list_tasks`
- Remove `chat_send_message`
- Update `SERVER_INSTRUCTIONS`

**4.2** Rewrite `crosschat.md`:
- Remove listener agent pattern (WebSocket delivers messages continuously)
- Document room semantics (one room at a time, default "general")
- Document task lifecycle: delegate → claim → accept → update → complete

**4.3** Delete `agents/crosschat-listener.md`

**4.4** Update `bin/cli.cjs`:
- Update permissions list for new tools
- Remove `chat_send_message` permission
- `status` command queries hub via REST instead of reading peers directory

**4.5** Update React frontend (`dashboard/src/`):
- Task board panel: active tasks, status, notes log
- Show which room each agent is in
- Task filter badges (agentId, workingDirReq, gitProject)
- Archive tasks from UI

**4.6** Add REST endpoints to hub:
- `GET /api/tasks` — list tasks, optional filters
- `GET /api/tasks/:id` — single task with full notes
- `POST /api/tasks/:id/archive` — archive a task

**4.7** Delete dead files:
- `src/transport/` directory (uds-server.ts, uds-client.ts, peer-protocol.ts)
- `src/registry/` directory (registry.ts, cleanup.ts)
- `src/dashboard/message-bridge.ts`
- `src/dashboard/dashboard-listener.ts`
- `src/stores/task-store.ts`

**4.8** Clean up `src/types.ts`:
- Remove: `PeerJsonRpcRequest`, `PeerJsonRpcResponse`, `PeerMessageParams`, `PeerDelegateTaskParams`, `PeerTaskUpdateParams`, `InboundTask`
- Remove `socketPath` from `PeerRegistryEntry`
- Update or remove `DelegatedTask`

**4.9** Handle edge cases:
- Hub crash/restart: agents reconnect with backoff, tasks reloaded from disk
- Agent crash: server removes from registry and room membership
- Stale lock file: hub checks `isProcessAlive` before trusting

---

## File Impact Summary

| File | Action | Phase |
|------|--------|-------|
| `src/hub/hub-server.ts` | NEW | 0 |
| `src/hub/hub-main.ts` | NEW | 0 |
| `src/hub/protocol.ts` | NEW | 1 |
| `src/hub/agent-connection.ts` | NEW | 1 |
| `src/hub/task-manager.ts` | NEW | 3 |
| `src/tools/join-room.ts` | NEW | 2 |
| `src/tools/create-room.ts` | NEW | 2 |
| `src/tools/claim-task.ts` | NEW | 3 |
| `src/tools/accept-claim.ts` | NEW | 3 |
| `src/tools/update-task.ts` | NEW | 3 |
| `src/tools/list-tasks.ts` | NEW | 3 |
| `src/lifecycle.ts` | MAJOR REWRITE | 0-2 |
| `src/server.ts` | REWRITE | 4 |
| `src/types.ts` | REWRITE | 1-3 |
| `src/dashboard/http-server.ts` | MOVE + EXPAND into hub | 0, 4 |
| `src/stores/message-store.ts` | MODIFY — add roomId | 2 |
| `src/tools/send-message.ts` | REWRITE — room-based | 2 |
| `src/tools/get-messages.ts` | REWRITE — room-scoped | 2 |
| `src/tools/wait-for-messages.ts` | REWRITE — WS-based | 2 |
| `src/tools/list-peers.ts` | REWRITE — query server | 1 |
| `src/tools/set-status.ts` | REWRITE — via WS | 1 |
| `src/tools/delegate-task.ts` | REWRITE — create task | 3 |
| `src/tools/complete-task.ts` | REWRITE — via WS | 3 |
| `src/tools/get-task-status.ts` | REWRITE — query server | 3 |
| `src/tools/chat-send.ts` | DELETE | 4 |
| `src/stores/task-store.ts` | DELETE | 3 |
| `src/transport/uds-server.ts` | DELETE | 4 |
| `src/transport/uds-client.ts` | DELETE | 4 |
| `src/transport/peer-protocol.ts` | DELETE | 4 |
| `src/registry/registry.ts` | DELETE | 4 |
| `src/registry/cleanup.ts` | DELETE | 4 |
| `src/dashboard/message-bridge.ts` | DELETE | 4 |
| `src/dashboard/dashboard-listener.ts` | DELETE | 4 |
| `agents/crosschat-listener.md` | DELETE | 4 |
| `crosschat.md` | REWRITE | 4 |
| `bin/cli.cjs` | UPDATE | 0, 4 |
| `dashboard/src/App.jsx` | UPDATE — task board | 4 |
| `dashboard/src/api.js` | UPDATE — task API | 4 |
| `package.json` | UPDATE | 0 |
