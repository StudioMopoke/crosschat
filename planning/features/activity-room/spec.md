# Activity Room — Feature Specification

## Problem Statement

The CrossChat hub tracks all significant lifecycle events (agent connections, task lifecycle, status changes, hub start/shutdown) via `log()` to stdout. But this information is invisible to dashboard users and agents — the only way to see what happened is to read server logs.

The existing "CrossChat Activity" room (`crosschat`) was seeded as a placeholder but only receives a single "Hub started" message. There's no real-time event timeline visible to users.

## Success Criteria

1. All significant hub lifecycle events are posted as system messages to the activity room
2. Dashboard users can see a live timeline of hub activity by viewing the activity room
3. Agents can opt in to the activity room via `join_room('crosschat')` to monitor hub events
4. Events are categorized by importance level (important/comment/chitchat) for future filtering
5. The activity room self-manages its message cap by dropping old events (no digest)

## User Stories

### US-1: Dashboard user monitors hub activity
**As a** dashboard user, **I want to** see a live feed of agent connections, task progress, and system events in the Activity Room, **so that** I can understand what's happening across the hub without reading server logs.

**Acceptance criteria:**
- Activity room shows agent connect/disconnect events with agent name and cwd
- Activity room shows task lifecycle events (created, claimed, accepted, completed, failed)
- Activity room shows hub lifecycle events (start, shutdown, idle timeout)
- Events appear in real-time via WebSocket broadcast
- Events are visible when first loading the dashboard (fetched via REST API)

### US-2: Agent monitors hub activity (opt-in)
**As an** agent, **I want to** join the activity room and read system events, **so that** I can be aware of what other agents are doing without being in the same room.

**Acceptance criteria:**
- Agent can join the activity room via `join_room('crosschat')`
- Agent receives real-time events via `wait_for_messages`
- Agent can read historical events via `get_messages`
- Agents do NOT auto-join the activity room — it's opt-in only

### US-3: Dashboard user posts to activity room
**As a** dashboard user, **I want to** send messages in the activity room alongside system events, **so that** I can annotate the event log with context or instructions.

**Acceptance criteria:**
- Dashboard users can type and send messages in the activity room (already works)
- User messages are visually distinguishable from system events (different `source` value)

## Event Categories

### Tier 1 — High Value
| Event | Importance | Message Format |
|-------|-----------|----------------|
| Agent connected | comment | `{name} connected (cwd: {path})` |
| Agent disconnected | comment | `{name} disconnected` |
| Task created | comment | `{creator} delegated task "{description}" -> {target}` |
| Task completed | important | `{agent} completed task "{description}"` |
| Task failed | important | `{agent} failed task "{description}"` |
| Agent status changed | chitchat | `{name} -> {status} ({detail})` |

### Tier 2 — Context
| Event | Importance | Message Format |
|-------|-----------|----------------|
| Room created | comment | `{name} created room "{roomName}"` |
| Agent joined room | chitchat | `{name} joined room "{roomName}"` |
| Task claimed | chitchat | `{claimant} claimed task "{description}"` |
| Task claim accepted | chitchat | `{creator} accepted claim from {claimant}` |
| Digest requested | comment | `{name} requested digest for room "{roomName}" ({count} messages)` |
| Digest completed | comment | `Digest completed for room "{roomName}"` |
| Message cap triggered | comment | `Room "{roomName}" hit message cap — auto-digest initiated` |

### Tier 3 — Ops/Debug
| Event | Importance | Message Format |
|-------|-----------|----------------|
| Hub started | important | `Hub started on port {port}` (already exists) |
| Hub shutting down | important | `Hub shutting down ({signal})` |
| Heartbeat failure | important | `{name} heartbeat failed — disconnecting` |
| Idle shutdown initiated | comment | `No agents connected — idle shutdown in {seconds}s` |
| Instance launched | comment | `Launched Claude Code at {path}` |
| Connection replaced | comment | `{name} reconnected (replaced existing connection)` |

### Excluded Events
- Individual room messages (too noisy — that's what rooms are for)
- Task update notes (already visible on the task itself)
- Permission events (dashboard-specific UI concern)
- Browser connect/disconnect (transient, not useful)

## Out of Scope

- **Admin agent role system** — Explicit agent elevation to admin is a future feature. For now, the activity room is accessible to any agent that opts in.
- **Room access control / ACLs** — No permission enforcement on who can join the activity room. Convention-based: agents don't auto-join.
- **Per-agent colors** — Assigning distinct colors to each agent is a separate feature (relates to instance settings).
- **Persistent instance names** — Coherent naming across CrossChat sessions is a separate feature (relates to instance settings).
- **Event type filtering** — Agents subscribing to specific event categories is overkill for v1.
- **Special dashboard styling for system messages** — Standard message rendering is fine for v1.

## Open Questions

1. **Activity room message cap behavior** — When the activity room hits 200 messages, should we skip the digest entirely and just drop the oldest messages? Or disable the cap for the activity room? (Decision: drop old events, no digest.)
2. **Rate limiting** — In a very busy hub (many agents connecting/disconnecting rapidly), could activity messages become excessive? The 200-message cap with drop handles this naturally, but worth monitoring.
