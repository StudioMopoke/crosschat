# Scope: Unified Messaging

## Phases

### Phase 1: Core Infrastructure (MVP)
**Goal:** Persistent messages, threads, badges, and task-as-flag — backend only.

**Deliverables:**
- MessageManager: persistent storage (JSONL), thread isolation, badge CRUD
- Simplified protocol types (channel.message, badge events)
- Hub server refactor: unified message handling, remove separate task system
- Room→channel rename across codebase
- Remove multi-room support (single "general" channel)

### Phase 2: MCP Tools
**Goal:** New unified tool set for agents.

**Deliverables:**
- Updated messaging tools: `send_message` (threadId), `get_messages` (threadId, badge filter), `wait_for_messages` (threadId)
- New tools: `flag_as_task`, `resolve_task`, `add_badge`
- Updated tools: `claim_task` (operates on flagged messages)
- Remove 8 obsolete tools
- Updated system instructions and prompts

### Phase 3: Dashboard
**Goal:** Unified message stream with badge rendering and thread UI.

**Deliverables:**
- Message badges: small round badges along bottom of each message
- Thread UI: expandable thread view on any message
- Task inline: flag/claim/resolve from dashboard
- Remove separate task panel
- Channel rename in UI
- Updated REST API endpoints

### Phase 4: Polish & Migration
**Goal:** Migration, documentation, edge cases.

**Deliverables:**
- Migration script for existing tasks → flagged messages
- Updated crosschat.md, CLAUDE.md, README
- CLI tool permission updates
- Version bump and publish

## Task Breakdown

| # | Task | Phase | Depends On | Complexity |
|---|------|-------|------------|------------|
| 1 | Design Message and Badge data model (TypeScript interfaces) | 1 | — | S |
| 2 | Implement MessageManager (persistent JSONL storage, thread isolation) | 1 | 1 | L |
| 3 | Implement badge CRUD on MessageManager | 1 | 2 | M |
| 4 | Implement TaskMeta storage (sidecar files for flagged messages) | 1 | 2 | M |
| 5 | Refactor protocol.ts: simplified types, room→channel rename | 1 | 1 | M |
| 6 | Refactor hub-server.ts: unified message routing, remove task handlers | 1 | 2, 5 | XL |
| 7 | Refactor agent-connection.ts: unified methods, room→channel | 1 | 5 | M |
| 8 | Remove multi-room support (join/create room handlers, room switching) | 1 | 6 | S |
| 9 | Remove TaskManager, migrate task persistence to MessageManager | 1 | 2, 4, 6 | M |
| 10 | Update send_message tool: add threadId parameter | 2 | 6, 7 | S |
| 11 | Update get_messages tool: add threadId, badge data in response | 2 | 6, 7 | S |
| 12 | Update wait_for_messages tool: thread-aware waiting | 2 | 6, 7 | M |
| 13 | Create flag_as_task tool | 2 | 4, 6 | M |
| 14 | Create resolve_task tool | 2 | 4, 6 | S |
| 15 | Create add_badge tool | 2 | 3, 6 | S |
| 16 | Update claim_task tool: operate on flagged messages | 2 | 4, 6 | S |
| 17 | Remove obsolete tools (8 tools) | 2 | 10-16 | S |
| 18 | Update server.ts: register new tools, update system instructions | 2 | 10-17 | M |
| 19 | Update types.ts and lifecycle.ts | 2 | 5 | S |
| 20 | Design badge UI component (round badges, colors, layout) | 3 | — | M |
| 21 | Implement message badge rendering in dashboard | 3 | 18, 20 | M |
| 22 | Implement thread expansion UI | 3 | 18 | L |
| 23 | Implement task inline actions (flag/claim/resolve from dashboard) | 3 | 13, 14, 16 | M |
| 24 | Remove separate task panel from dashboard | 3 | 21, 22, 23 | S |
| 25 | Update dashboard API layer (channels, badges, threads) | 3 | 6 | M |
| 26 | Update REST API endpoints (rooms→channels, new badge/thread endpoints) | 3 | 6 | M |
| 27 | Migration script: existing tasks → flagged messages | 4 | 2, 4 | M |
| 28 | Update crosschat.md documentation | 4 | 18 | S |
| 29 | Update CLAUDE.md and README | 4 | 18 | S |
| 30 | Update CLI (bin/cli.cjs): tool permissions, channel references | 4 | 17 | S |
| 31 | Version bump and publish | 4 | All | S |

**Complexity key:** S = small (< 1hr), M = medium (1-3hr), L = large (3-6hr), XL = extra large (6hr+)

## Testing Strategy

### Unit Tests (future)
- MessageManager: write/read/thread isolation, badge CRUD, cap enforcement
- TaskMeta: flag/claim/resolve lifecycle
- Protocol: message serialization with badges

### Integration Tests (manual)
- Send message → appears in channel with badges
- Reply in thread → thread persists across hub restart
- Flag message as task → delegation cycle works
- Claim task → first-come-first-served, rejects duplicates
- Dashboard: badges render, threads expand, task actions work

### Smoke Tests
- Hub restart: all messages and threads survive
- Agent reconnect: receives messages with badge data
- Badge update: all agents notified
- 200 message cap: overflow to digest, threads unaffected
