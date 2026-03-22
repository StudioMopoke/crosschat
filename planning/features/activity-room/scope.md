# Activity Room — Scope & Task Breakdown

## Delivery

Single phase — all tasks delivered together.

## Task Breakdown

| # | Task | Depends On | Complexity |
|---|------|-----------|------------|
| 1 | Add `postActivity()` and `dropOldActivityMessages()` helpers in hub-server.ts | — | Small |
| 2 | Fix hub startup message: change `source: 'agent'` to `source: 'system'`, refactor to use `postActivity()` | 1 | Small |
| 3 | Skip digest for activity room in `enforceRoomMessageCap()` | — | Small |
| 4 | Add `onActivity` callback to TaskManager constructor | 1 | Small |
| 5 | Add `postActivity()` calls at connection events (connect, disconnect, replaced, heartbeat failure) | 1 | Small |
| 6 | Add `postActivity()` calls at room events (join, create) | 1 | Small |
| 7 | Add `postActivity()` calls at status change events | 1 | Small |
| 8 | Add `postActivity()` calls at digest events (cap triggered, requested, completed) | 1 | Small |
| 9 | Add `postActivity()` calls at hub lifecycle events (shutdown, idle shutdown, instance launched) | 1 | Small |
| 10 | Add `onActivity()` calls at task lifecycle events in task-manager.ts (created, claimed, accepted, completed, failed) | 4 | Small |
| 11 | Manual testing: verify events appear in dashboard activity room | 1-10 | Medium |
| 12 | Manual testing: verify agent opt-in via `join_room('crosschat')` receives events | 1-10 | Small |

**Total complexity:** Small — ~20 call sites across 2 files, plus 2 small helper functions.

## Testing Strategy

### Manual Testing
- Start hub, verify "Hub started" message appears in activity room
- Connect agents, verify connect/disconnect events
- Create and complete tasks, verify task lifecycle events
- Join rooms, verify room events
- Change status, verify status change events
- Let message cap fill, verify old events are dropped (not digested)
- Join activity room from an agent, verify events received via `wait_for_messages`

### Verification Checklist
- [ ] All Tier 1 events post correctly
- [ ] All Tier 2 events post correctly
- [ ] All Tier 3 events post correctly
- [ ] Dashboard displays events in real-time
- [ ] Dashboard loads historical events on room selection
- [ ] Agent opt-in works via `join_room('crosschat')`
- [ ] Old events drop when cap exceeded (no digest created)
- [ ] Hub startup message has `source: 'system'` (not `'agent'`)
- [ ] No duplicate events (e.g., digest completion doesn't post twice)
- [ ] Build passes (`npm run build`)

## Related Future Features

- **Admin agent role** — Explicit agent elevation for admin duties; could restrict activity room access
- **Per-agent colors** — Distinct colors per agent in dashboard, configurable via instance settings
- **Persistent instance names** — Coherent agent naming across CrossChat sessions via instance settings
- **Event type filtering** — Agents subscribing to specific activity event categories
- **Structured event metadata** — Adding machine-readable metadata to activity messages for programmatic consumption
