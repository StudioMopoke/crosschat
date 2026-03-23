# Sprint 1: Unified Messaging

**Feature:** [Unified Messaging](../../features/unified-messaging/spec.md)
**Goal:** Replace the dual message+task system with unified persistent messaging, threads, badges, and the new MCP tool set. Update dashboard with badge rendering and thread UI. Publish new version.

## Parallel Tracks

```
Track A: Data Layer          Track B: Protocol & Hub       Track D: Dashboard
─────────────────────        ──────────────────────        ──────────────────
1. Data model ──────────┐    5. Protocol refactor ─┐      20. Badge UI design
2. MessageManager ──┐   │    6. Hub refactor ──────┤      21. Badge rendering
3. Badge CRUD       │   │    7. Agent connection   │      22. Thread UI
4. TaskMeta         │   │    8. Remove multi-room  │      23. Task inline actions
9. Remove TaskMgr ──┘   │    26. REST endpoints    │      24. Remove task panel
                        │                          │      25. Dashboard API
                        │                          │
                        └─── Track C: MCP Tools ───┘
                             ──────────────────────
                             10. send_message (threadId)
                             11. get_messages (threadId)
                             12. wait_for_messages (thread)
                             13. flag_as_task
                             14. resolve_task
                             15. add_badge
                             16. claim_task (update)
                             17. Remove obsolete tools
                             18. server.ts + instructions
                             19. types.ts + lifecycle.ts

                        Track E: Polish
                        ───────────────
                        27. Migration script
                        28. crosschat.md
                        29. CLAUDE.md + README
                        30. CLI updates
                        31. Version bump + publish
```

## Task Table

| # | Task | Track | Depends On | Complexity | Status |
|---|------|-------|------------|------------|--------|
| 1 | Data model (Message, Badge, TaskMeta interfaces) | A | — | S | |
| 2 | MessageManager (JSONL storage, thread isolation) | A | 1 | L | |
| 3 | Badge CRUD on MessageManager | A | 2 | M | |
| 4 | TaskMeta storage (sidecar files) | A | 2 | M | |
| 5 | Protocol refactor (simplified types, room→channel) | B | 1 | M | |
| 6 | Hub server refactor (unified routing, remove task handlers) | B | 2, 5 | XL | |
| 7 | Agent connection refactor (unified methods, room→channel) | B | 5 | M | |
| 8 | Remove multi-room support | B | 6 | S | |
| 9 | Remove TaskManager | A | 2, 4, 6 | M | |
| 10 | send_message: add threadId | C | 6, 7 | S | |
| 11 | get_messages: add threadId, badges | C | 6, 7 | S | |
| 12 | wait_for_messages: thread-aware | C | 6, 7 | M | |
| 13 | flag_as_task tool | C | 4, 6 | M | |
| 14 | resolve_task tool | C | 4, 6 | S | |
| 15 | add_badge tool | C | 3, 6 | S | |
| 16 | claim_task: update for flagged messages | C | 4, 6 | S | |
| 17 | Remove 8 obsolete tools | C | 10-16 | S | |
| 18 | server.ts: register tools, update instructions | C | 10-17 | M | |
| 19 | types.ts + lifecycle.ts updates | C | 5 | S | |
| 20 | Badge UI component design | D | — | M | |
| 21 | Message badge rendering | D | 18, 20 | M | |
| 22 | Thread expansion UI | D | 18 | L | |
| 23 | Task inline actions (flag/claim/resolve) | D | 13, 14, 16 | M | |
| 24 | Remove task panel | D | 21, 22, 23 | S | |
| 25 | Dashboard API layer update | D | 6 | M | |
| 26 | REST API endpoints (rooms→channels, badges, threads) | B | 6 | M | |
| 27 | Migration script (tasks → flagged messages) | E | 2, 4 | M | |
| 28 | crosschat.md docs | E | 18 | S | |
| 29 | CLAUDE.md + README | E | 18 | S | |
| 30 | CLI updates (permissions, channel refs) | E | 17 | S | |
| 31 | Version bump + publish | E | All | S | |

## Success Criteria

- [ ] Messages persist across hub restarts
- [ ] Threads work: reply to any message, thread persists
- [ ] Any message can be flagged as a task
- [ ] Task lifecycle works on flagged messages (claim, resolve)
- [ ] Badges render in dashboard as round badges on messages
- [ ] Thread expansion works in dashboard
- [ ] MCP tools reduced from 16 to 9
- [ ] Single "general" channel, no room switching
- [ ] All references renamed from room → channel
- [ ] Existing tasks migrated or deprecated
- [ ] Published as new version

## Agent Assignment Strategy

With 3 agents available:
- **Agent 1 (crosschat):** Track A (data layer) → Track C (tools)
- **Agent 2 (crosschat-2):** Track B (protocol & hub)
- **Agent 3 (crosschat-3):** Track D (dashboard) — can start task 20 immediately

Track E (polish) is picked up by whoever finishes first.
