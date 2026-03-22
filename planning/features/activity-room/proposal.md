# Feature: CrossChat Activity Room

## Summary

Flesh out the existing "CrossChat Activity" room (`crosschat`) as a live system event log. The hub already tracks all significant lifecycle events via `log()` — this feature would additionally post structured system messages to the activity room so agents and dashboard users can see what's happening across the hub in real-time.

## Problem

The activity room currently only receives a single "Hub started" message. All other hub events (connections, tasks, errors) are logged to stdout but invisible to agents and dashboard users. There's no way to see a timeline of what happened without reading server logs.

## Proposed Events

Events grouped by category, with suggested importance levels:

### Tier 1 — High Value (implement first)

| Event | Importance | Example Message |
|-------|-----------|----------------|
| Agent connected | comment | `🟢 crosschat-7bb6 connected (cwd: /path/to/project)` |
| Agent disconnected | comment | `🔴 crosschat-7bb6 disconnected` |
| Task created | comment | `📋 crosschat-7bb6 delegated task "Refactor auth module" → crosschat-2-618d` |
| Task completed | important | `✅ crosschat-2-618d completed task "Refactor auth module"` |
| Task failed | important | `❌ crosschat-2-618d failed task "Refactor auth module"` |
| Agent status changed | chitchat | `crosschat-2-618d → busy (Running tests for auth module)` |

### Tier 2 — Useful Context

| Event | Importance | Example Message |
|-------|-----------|----------------|
| Room created | comment | `crosschat-7bb6 created room "sprint-planning"` |
| Agent joined room | chitchat | `crosschat-7bb6 joined room "sprint-planning"` |
| Task claimed | chitchat | `crosschat-2-618d claimed task "Refactor auth module"` |
| Task claim accepted | chitchat | `crosschat-7bb6 accepted claim from crosschat-2-618d` |
| Digest requested | comment | `crosschat-7bb6 requested digest for room "general" (45 messages)` |
| Digest completed | comment | `Digest completed for room "general" → ~/.crosschat/digests/general/...` |
| Message cap triggered | comment | `Room "general" hit 200-message cap — auto-digest initiated` |

### Tier 3 — Ops/Debug

| Event | Importance | Example Message |
|-------|-----------|----------------|
| Hub started | important | `Hub started on port 54665` (already exists) |
| Hub shutting down | important | `Hub shutting down (SIGTERM)` |
| Heartbeat failure | important | `crosschat-7bb6 heartbeat failed — disconnecting` |
| Idle shutdown initiated | comment | `No agents connected — idle shutdown in 5 minutes` |
| Instance launched | comment | `Launched Claude Code at /path/to/project` |
| Connection replaced | comment | `crosschat-7bb6 reconnected (replaced existing connection)` |

### Not Included

- Individual messages sent (too noisy — that's what rooms are for)
- Task update notes (already visible on the task itself)
- Permission events (dashboard-specific, agents don't need these in a room)
- Browser connect/disconnect (transient, not useful)

## Implementation Approach

### Option A: Helper function in hub-server.ts (Recommended)

Add a `postActivity()` helper that creates a system message and pushes it to the `crosschat` room:

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
    source: 'agent',
    importance,
  };
  room.messages.push(msg);
  broadcastToRoom('crosschat', msg, 'browsers'); // show on dashboard
  enforceRoomMessageCap(room); // respect the 200-message cap
}
```

Then sprinkle `postActivity()` calls at each event site — the hub already has `log()` calls at all these locations, so it's straightforward to add a parallel `postActivity()` next to each one.

### Option B: Event emitter pattern

Introduce an EventEmitter on the hub, emit typed events at each lifecycle point, and have the activity room subscribe. More decoupled but more engineering for the same result. Better if we later want multiple subscribers (e.g., webhooks, external logging).

### Recommendation

**Option A** for now. It's simple, the scope is contained to `hub-server.ts` + `task-manager.ts`, and we can refactor to an event emitter later if needed.

## Scope & Effort

- ~15-20 `postActivity()` calls across hub-server.ts
- ~3-5 calls in task-manager.ts (would need to pass the helper or the room reference)
- No new tools, no protocol changes, no client changes needed
- Dashboard already renders system messages — activity room "just works" in the UI
- Agents can join the activity room and read events via existing `join_room` + `get_messages`

## Open Questions

1. **Should agents auto-join the activity room?** Or keep it opt-in (agents `join_room('crosschat')` when they want updates)?
2. **Digest behavior** — should the activity room digest like any other room, or should old events just be dropped?
3. **Filtering** — should agents be able to subscribe to specific event types? (Probably overkill for v1.)
4. **Rate limiting** — in a busy hub, could activity messages become too noisy? (The 200-message cap with auto-digest should handle this naturally.)
