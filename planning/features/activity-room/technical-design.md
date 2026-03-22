# Activity Room — Technical Design

## Overview

Add a `postActivity()` helper function to the hub server that posts structured system messages to the "CrossChat Activity" room at lifecycle event sites. The hub already has `log()` calls at every relevant event — we add a parallel `postActivity()` call alongside each one.

No new tools, protocol changes, or client changes required. The dashboard already renders room messages and auto-selects the activity room on first load.

## Architecture

```
Hub lifecycle event
  └─> log()                     (existing: stdout)
  └─> postActivity(content)     (NEW: system message to 'crosschat' room)
        ├─> room.messages.push(msg)
        ├─> broadcastToRoomBrowsers()    (real-time to dashboard)
        ├─> broadcastToRoomAgents()      (real-time to opted-in agents)
        └─> dropOldMessages()            (cap enforcement, no digest)
```

## Dependencies

### Internal
- **Room system** — activity room already seeded as `'crosschat'` (hub-server.ts:226-231)
- **broadcastRoomMessage()** — existing function to broadcast to agents + browsers (hub-server.ts:395-440)
- **ChatMessage type** — existing type with `source`, `importance`, `metadata` fields (hub-server.ts:87-99)
- **generateId()** — existing ID generator (util/id.ts)

### External
- None — no new dependencies

### Ordering
- `postActivity()` must be defined after room seeding (line 231) and after broadcast helpers (line 440)
- Task events in task-manager.ts need a way to call `postActivity()` — pass as callback or restructure

## Key Changes

### New Code

| File | Change | Description |
|------|--------|-------------|
| `src/hub/hub-server.ts` | Add `postActivity()` helper | Core helper function ~15 lines |
| `src/hub/hub-server.ts` | Add `dropOldActivityMessages()` | Activity-specific cap without digest |
| `src/hub/hub-server.ts` | ~15 `postActivity()` call sites | At existing lifecycle event locations |
| `src/hub/task-manager.ts` | ~5 `postActivity()` call sites | Task lifecycle events |

### Modified Code

| File | Change | Description |
|------|--------|-------------|
| `src/hub/hub-server.ts:1821-1833` | Fix existing hub startup message | Change `source: 'agent'` to `source: 'system'` |
| `src/hub/hub-server.ts` | Activity room cap behavior | Skip digest for 'crosschat' room in `enforceRoomMessageCap()` |
| `src/hub/task-manager.ts` constructor | Accept `postActivity` callback | So task manager can post activity events |

### No Changes Needed

| File | Reason |
|------|--------|
| `src/tools/*` | No tool changes — agents join activity room via existing `join_room` |
| `src/types.ts` | No new types needed |
| `src/server.ts` | No MCP server changes |
| `src/prompts.ts` | No prompt changes (could optionally mention the activity room) |
| `dashboard/*` | Dashboard already renders system messages and auto-selects the activity room |

## Interfaces & Data

### postActivity() Helper

```typescript
function postActivity(content: string, importance: MessageImportance = 'comment'): void {
  const room = rooms.get('crosschat');
  if (!room) return;

  const msg: ChatMessage = {
    messageId: generateId(),
    roomId: 'crosschat',
    fromPeerId: 'system',
    fromName: 'system',
    content,
    timestamp: new Date().toISOString(),
    source: 'system',
    importance,
  };

  room.messages.push(msg);
  broadcastRoomMessage('crosschat', msg);
  dropOldActivityMessages(room);
}
```

### dropOldActivityMessages() Helper

Activity room drops old messages without creating a digest task:

```typescript
function dropOldActivityMessages(room: Room): void {
  if (room.messages.length > ROOM_MESSAGE_CAP) {
    room.messages = room.messages.slice(-ROOM_MESSAGE_CAP);
  }
}
```

### enforceRoomMessageCap() Modification

Skip digest creation for the activity room:

```typescript
async function enforceRoomMessageCap(room: Room): Promise<void> {
  if (room.id === 'crosschat') return; // activity room handles its own cap
  // ... existing digest logic
}
```

### TaskManager Callback

```typescript
// In hub-server.ts, when creating TaskManager:
const taskManager = new TaskManager(
  TASKS_DIR,
  (content: string, importance?: MessageImportance) => postActivity(content, importance)
);

// In task-manager.ts constructor:
constructor(
  private tasksDir: string,
  private onActivity?: (content: string, importance?: MessageImportance) => void
) { ... }
```

## Call Sites

### hub-server.ts — Connection Events

| Line (approx) | Event | Call |
|----------------|-------|------|
| 1626 | Agent registered | `postActivity(\`${agent.name} connected (cwd: ${agent.cwd})\`)` |
| 585 | Agent disconnected | `postActivity(\`${agent.name} disconnected\`)` |
| 1606 | Connection replaced | `postActivity(\`${agent.name} reconnected (replaced existing connection)\`)` |
| 1756 | Heartbeat failure | `postActivity(\`${agent.name} heartbeat failed — disconnecting\`, 'important')` |

### hub-server.ts — Room Events

| Line (approx) | Event | Call |
|----------------|-------|------|
| 637 | Agent joined room | `postActivity(\`${agent.name} joined room "${roomId}"\`, 'chitchat')` |
| 663 | Room created | `postActivity(\`${agent.name} created room "${name}"\`)` |

### hub-server.ts — Status Events

| Line (approx) | Event | Call |
|----------------|-------|------|
| 605 | Status changed | `postActivity(\`${agent.name} -> ${status}${detail ? ' (' + detail + ')' : ''}\`, 'chitchat')` |

### hub-server.ts — Digest Events

| Line (approx) | Event | Call |
|----------------|-------|------|
| 497 | Message cap triggered | `postActivity(\`Room "${roomId}" hit message cap — auto-digest initiated\`)` |
| 982 | Digest requested | `postActivity(\`${agent.name} requested digest for room "${roomId}"\`)` |
| 576 | Digest completed | `postActivity(\`Digest completed for room "${roomId}"\`)` |

### hub-server.ts — Hub Lifecycle

| Line (approx) | Event | Call |
|----------------|-------|------|
| 1818 | Hub started | Replace existing startup message with `postActivity()` call |
| 1846 | Hub shutting down | `postActivity(\`Hub shutting down (${signal})\`, 'important')` |
| 590 | Idle shutdown | `postActivity(\`No agents connected — idle shutdown in 300s\`)` |
| 1497 | Instance launched | `postActivity(\`Launched Claude Code at ${path}\`)` |

### task-manager.ts — Task Events

| Line (approx) | Event | Call |
|----------------|-------|------|
| 88 | Task created | `this.onActivity?.(\`${creatorName} delegated task "${description}"\`)` |
| 111 | Task claimed | `this.onActivity?.(\`${claimantName} claimed task "${description}"\`, 'chitchat')` |
| 134 | Claim accepted | `this.onActivity?.(\`${creatorName} accepted claim from ${claimantName}\`, 'chitchat')` |
| 219 (completed) | Task completed | `this.onActivity?.(\`${authorName} completed task "${description}"\`, 'important')` |
| 219 (failed) | Task failed | `this.onActivity?.(\`${authorName} failed task "${description}"\`, 'important')` |

## Alternatives Considered

### Event Emitter Pattern
Introduce an EventEmitter on the hub, emit typed events at lifecycle points, subscribe from the activity room. More decoupled but more engineering for the same result. Would be better if we later want multiple subscribers (webhooks, external logging). **Rejected for now** — can refactor later if needed.

### Metadata-rich Messages
Include structured metadata on activity messages (e.g., `{ eventType: 'agent.connected', peerId: '...', cwd: '...' }`). Useful for programmatic consumption but adds complexity. **Deferred** — can add metadata later without breaking changes.

## Risks

1. **Message volume in busy hubs** — Many agents connecting/disconnecting rapidly could generate excessive activity messages. Mitigated by the 200-message drop cap.
2. **Task manager coupling** — Passing `postActivity` as a callback adds a dependency. Mitigated by making it optional (`onActivity?.()`).
3. **Activity room broadcast to agents** — If many agents opt into the activity room, each event generates N WebSocket messages. Low risk since opt-in is expected to be rare.
