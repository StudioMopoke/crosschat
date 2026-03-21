# CrossChat Audit Synthesis

_Generated 2026-03-21 from five parallel Opus deep-dives: Code Quality & Architecture, Context Pollution, Dashboard UX, Security & Cloud Architecture, Monetization._

---

## Overview

CrossChat v1.4.1 is an MCP server (~3,200 lines TypeScript + ~1,000-line React dashboard + ~630-line CJS CLI) enabling inter-instance Claude Code communication through a hub-and-spoke architecture. The codebase is lean, the dependency footprint is healthy, and the core protocol design is solid. The most urgent issues are security (zero auth anywhere), unbounded resource growth, and context pollution from verbose/duplicated instructions.

This document deduplicates findings across all five audits into a single prioritized list with concrete remediation paths.

---

## CRITICAL — Must Fix Before Any Public/Cloud Deployment

### C1. Zero Authentication on All Surfaces
**Sources:** Security, Code Quality, Cloud Architecture

No auth token, API key, session cookie, or credential of any kind exists anywhere. Impact:

- **WebSocket agents**: Any process that discovers the port can register with arbitrary `peerId`/`name` and read all messages, manipulate tasks, impersonate agents
- **REST API**: All 14 endpoints are wide open — any local process can approve permissions, inject messages, clear rooms, launch terminals
- **Dashboard**: Username prompt is cosmetic (localStorage only), no server-side session
- **Agent hijacking**: Sending `agent.register` with an existing agent's `peerId` *replaces* the legitimate connection (hub explicitly closes the old one at hub-server.ts:1219-1223)
- **CORS is `Access-Control-Allow-Origin: *`** (hub-server.ts:772) — any webpage in the user's browser can access the API

**Remediation:**
1. Generate a shared secret at hub start, store in `dashboard.lock`
2. Require it as `Authorization: Bearer <token>` on all REST calls and as a query param on WebSocket upgrade
3. Restrict CORS to `localhost` origins only
4. For cloud: layer JWT (browsers) + API keys (agents) on top

### C2. Permission System is Trivially Bypassable
**Sources:** Security, Code Quality

The permission hook sends tool calls to the hub for dashboard approval, but:

- `GET /api/permissions` lists all pending requests (no auth)
- `POST /api/permissions/:id/decide` accepts decisions (no auth)
- A ~5 line script can poll and auto-approve everything, completely undermining the permission elevation feature
- This creates a **false sense of security** — the dashboard shows approval UX but any local process can silently approve all requests

**Remediation:** Auth on decide endpoint (C1 fixes this). Additionally, restrict permission decisions to browser WebSocket clients only (not REST).

### C3. Command Injection via Project Launch
**Sources:** Security, Code Quality

`POST /api/projects/:id/launch` (hub-server.ts:1122-1130) interpolates user-supplied project paths into an AppleScript string with minimal escaping (only backslashes and double-quotes). Combined with zero auth, any local process can register a project with a crafted path and potentially execute arbitrary commands via `osascript`.

**Remediation:** Validate paths strictly (reject shell metacharacters), or replace AppleScript string interpolation with a safer launch mechanism. Also: this endpoint is macOS-only with no fallback — returns no error on Linux/Windows.

---

## HIGH — Should Fix Before Wider Adoption

### H1. Unbounded Memory Growth (Messages)
**Sources:** Code Quality, Context Pollution, Security

Room messages accumulate in-memory forever on both hub and client sides:
- Hub: `Room.messages: ChatMessage[]` — no cap, no TTL, no eviction (hub-server.ts:95)
- Client: `MessageStore.messages: PeerMessage[]` — no max, no pruning (message-store.ts:7)
- Only mitigation is explicit `clear_session` (nuclear option, wipes everything)
- A hub running for days with active agents will consume ever-increasing memory

**Remediation:** Add configurable max messages per room (e.g., 1000, drop oldest). Add auto-pruning of read messages older than N minutes on the client side.

### H2. Unbounded Task Accumulation on Disk
**Sources:** Code Quality

Every task persists as a JSON file in `~/.crosschat/tasks/` and is never deleted — only status-transitioned to `archived`. The in-memory Map and disk directory grow without bound.

**Remediation:** Periodic cleanup of archived tasks older than a configurable threshold.

### H3. Context Pollution — 5,600 Tokens of Static Overhead
**Sources:** Context Pollution

CrossChat injects ~5,600 tokens into every agent conversation:
- **MCP tool schemas**: ~1,500 tokens (always present, unavoidable)
- **SERVER_INSTRUCTIONS** (server.ts:21-65): ~1,100 tokens — largely duplicates what tool schemas already say
- **crosschat.md** slash command: ~3,000 tokens — contains a *third* copy of tool descriptions

Specific issues:
- Tool descriptions listed **three times** (schemas + SERVER_INSTRUCTIONS + crosschat.md)
- The autonomy rule appears **three times** within crosschat.md alone
- Parameter `.describe()` strings contain workflow instructions that belong in system prompt, not schemas
- Dead `includeMetadata` parameter wastes ~30 tokens on every conversation: "Kept for compatibility — metadata is always included now"
- All JSON responses use `JSON.stringify(..., null, 2)` adding ~30% unnecessary whitespace tokens

**Remediation (target ~3,800 tokens, 32% reduction):**
1. Remove tool re-listing from SERVER_INSTRUCTIONS (~400 token savings)
2. Compress crosschat.md — remove triple-repeated content (~1,200 token savings)
3. Shorten verbose `.describe()` strings on parameters (~200 token savings)
4. Switch to compact JSON in tool responses (15-30% per response)
5. Remove dead `includeMetadata` parameter

### H4. `get_messages` Defaults to Unlimited History
**Sources:** Context Pollution

`get_messages` with no `limit` parameter returns the **entire room history** — all messages since the agent joined, with 11 fields per message, pretty-printed. A 50-message room dumps ~7,500 tokens from a single call.

**Remediation:** Default `limit` to 20. Add pagination support.

### H5. Hub Server is a 1,470-Line God-File
**Sources:** Code Quality

`hub-server.ts` contains: lock file management, project store, permission store, room management, agent registry, mention parsing, all 14+ message handlers, the Express REST API, both WebSocket servers, heartbeat logic, HTTP server setup, and graceful shutdown.

**Remediation:** Extract into: `room-manager.ts`, `permission-store.ts`, `project-store.ts`, `rest-api.ts`, `agent-registry.ts`, `mention-parser.ts`. `startHub()` composes them.

### H6. Dashboard Has No WebSocket Reconnection
**Sources:** Dashboard UX

`useWebSocket.js` connects once and never reconnects. If the hub restarts or the network blips, the dashboard goes dead — no indicator, no recovery. The agent-side `AgentConnection` has full exponential-backoff reconnection, but the browser hook has none.

**Remediation:** Add reconnection with exponential backoff. Show a visible "Disconnected — reconnecting..." banner.

### H7. Hardcoded Stale Version `'1.2.0'`
**Sources:** Code Quality

Both `hub-server.ts:165` (`getServerVersion()`) and `server.ts:89` (MCP `version` field) return hardcoded `'1.2.0'` while `package.json` is at `1.4.1`.

**Remediation:** Import version from `package.json` everywhere.

---

## MEDIUM — Important for Quality and Reliability

### M1. Race Condition on Concurrent Task Claims
**Sources:** Code Quality

`TaskManager.claim()` is async (disk persistence) with no locking. Two simultaneous claims on the same task could both pass the status check before either persists. Same race exists for `acceptClaim`, `update`, `complete`.

**Remediation:** Add per-taskId in-memory lock (e.g., `Map<string, Promise>`) to serialize operations.

### M2. Dashboard Ignores WebSocket Events It Should Use
**Sources:** Dashboard UX

The hub broadcasts `task.created`, `task.claimed`, `task.updated`, `task.completed`, `agentJoined`, `agentLeft`, and `sessionCleared` events. The dashboard explicitly ignores task events (App.jsx:839) and doesn't handle agent join/leave. Instead it polls tasks every 5s and peers every 10s.

**Remediation:** Wire WebSocket events to update state in real-time. Remove polling fallbacks.

### M3. Fire-and-Forget Sends Silently Drop Messages
**Sources:** Code Quality

`AgentConnection.send()` (agent-connection.ts:314) silently returns when WebSocket is not open. All tools wrapping these sends report success even when the message was dropped.

**Remediation:** Have `send()` throw or return boolean when disconnected. Tools should report connection errors.

### M4. Pending Permissions Never Cleaned Up
**Sources:** Code Quality, Security

Decided permissions get a 60-second cleanup `setTimeout`. Undecided (pending) permissions linger in `pendingPermissions` forever if the hook times out or the agent disconnects.

**Remediation:** Add a TTL sweep for pending permissions (e.g., 10 minutes).

### M5. `get_task_status` is Broken + Inefficient
**Sources:** Code Quality, Context Pollution

Two issues:
1. It fetches ALL tasks then does `.find()` client-side — no single-task protocol message despite `GET /api/tasks/:id` existing on the hub
2. The tool description promises "full details including notes history" but `taskToSummary` strips notes — this is a **functional bug** + misleading description

**Remediation:** Add a `task.get` protocol message. Return full task (with notes) for single-task lookups.

### M6. `clear_session` Missing from Permissions Allowlist
**Sources:** Code Quality

`CROSSCHAT_PERMISSIONS` in cli.cjs doesn't include `mcp__crosschat__clear_session`, so it always requires manual approval.

**Remediation:** Add `"mcp__crosschat__clear_session"` to the array.

### M7. Duplicate Type Definitions
**Sources:** Code Quality

- `TaskFilter` defined identically in `protocol.ts` and `task-manager.ts`
- `TaskNote` defined identically in `protocol.ts` and `task-manager.ts`
- `DashboardLock` defined in `hub-server.ts` and `lifecycle.ts` with *different shapes*

**Remediation:** Single source of truth in `types.ts`, import everywhere.

### M8. No Dashboard Notifications for Permissions
**Sources:** Dashboard UX

Permission requests appear as silent toasts in the top-right. If the tab is backgrounded, the user never sees them and agents block indefinitely. No browser Notification API, no sound.

**Remediation:** Use `Notification` API + optional audio tone for permission requests.

### M9. Shell Variable Injection in Permission Hook
**Sources:** Security

In `permission-hook.sh:98`, `$REASON` is interpolated into a heredoc without escaping. A dashboard user entering special characters in the denial reason could break the JSON output.

**Remediation:** Escape the reason string or use `jq` to construct the JSON output safely.

### M10. No Rate Limiting or Connection Limits
**Sources:** Security

No rate limits on any endpoint. No max WebSocket connections. No `maxPayload` on WebSocket servers (defaults to 100MB). A single client can flood the hub.

**Remediation:** Add per-connection rate limits, max connection count, and WebSocket `maxPayload` (e.g., 1MB).

---

## LOW — Maintenance Debt and Polish

### L1. Zero Test Coverage
No unit tests, integration tests, or E2E tests anywhere. Critical untested paths: task state machine, WebSocket message routing, mention parsing, concurrent connections.

### L2. Dashboard is a 987-Line Single Component
Entire app in one `App.jsx` — ~15 components should be in separate files. No TypeScript, no tests.

### L3. CLI `stop()` Uses Synchronous Busy-Wait
Blocks the event loop for up to 5 seconds with `while (Date.now() < waitUntil) {}`.

### L4. `type?: any` for Task Status Filters
hub-server.ts:689 and 887 use `any` — bypasses TypeScript type checking on task status.

### L5. `decodeMessage` Doesn't Validate Message Shape
Only checks for a string `type` field, then casts. A malformed registration missing `peerId` would be accepted.

### L6. macOS-Only Project Launch
`osascript` only works on macOS. No fallback, no error on other platforms.

### L7. Code Duplication Across 15 Tool Files
Every tool has identical try/catch + error formatting boilerplate. Should extract `toolError()`/`toolSuccess()` helpers.

### L8. Events Array Grows Unbounded in Dashboard
Join events accumulate in state forever, never cleaned up (App.jsx:849).

### L9. No Dashboard Empty States
Peers bar renders nothing when empty (`if (!peers.length) return null`) — should show "No agents connected."

### L10. Dashboard Not Responsive
Fixed 260px sidebar, no `@media` queries, unusable on mobile/tablet.

### L11. Dashboard Accessibility Gaps
Missing aria-labels, no keyboard navigation, no focus-visible styles, color contrast issues on muted text and status badges.

---

## Dashboard Feature Gaps

| Capability | Status |
|---|---|
| WebSocket reconnection | Missing |
| Task creation from dashboard | Missing (API exists) |
| Room clearing from dashboard | Missing (API exists) |
| Task filtering by room/agent | Missing (API supports it) |
| Real-time task/peer updates via WS | Available but ignored |
| Markdown rendering in tasks | Missing (raw text only) |
| Unread indicators on rooms | Missing |
| Search (messages, tasks, agents) | Missing |
| Overview/home dashboard view | Missing |
| Permission timeout indicator | Missing |
| "Allow all for session" option | Missing |
| Permission decision history | Missing |
| Dark/light theme toggle | Missing (dark only) |

---

## Cloud Architecture Path

### Phase 1 — Minimal Viable Cloud (4-6 weeks)
- Auth: JWT for browsers + API keys for agents
- `CROSSCHAT_HUB_URL` support in AgentConnection/lifecycle (skip local hub spawn)
- PostgreSQL for persistence (messages, tasks, rooms, users)
- TLS via reverse proxy, origin checking on WebSocket
- Single instance on Fly.io/Railway (~$15-30/mo)

### Phase 2 — Production Ready (2-3 months)
- Multi-tenancy: teams, RBAC, invitations
- Redis pub/sub for horizontal scaling
- Rate limiting, message size caps, audit logging
- Data retention policies, monitoring/alerting

### Phase 3 — Enterprise (3-6 months)
- Dedicated per-customer instances
- SSO/SAML, IP allowlisting
- End-to-end encryption, SOC2 certification
- Data residency options, SLA guarantees

### Dual-Mode Codebase
Same code serves both:
- **Localhost** (default): no auth, auto-spawn hub, in-memory — absence of `CROSSCHAT_HUB_URL`
- **Cloud**: auth required, remote hub, persistent storage — presence of `CROSSCHAT_HUB_URL`

---

## Monetization Summary

### Tiers
| Tier | Price | Key Feature |
|---|---|---|
| Free | $0 | Single-machine hub, unlimited local agents |
| Pro | $19/mo | Cloud hub, persistent history, analytics |
| Team | $49/user/mo | Shared hub, RBAC, audit logs, SSO, integrations |
| Enterprise | ~$200/user/mo | Dedicated instances, SOC2, on-premise, SLA |

### Revenue Projections
| Month | MRR |
|---|---|
| 6 | $380 |
| 12 | $6,250 |
| 18 | $25,200 |
| 24 | $58,600 |

### Three Quick Wins (do now)
1. **Telemetry + GitHub star nudge** in install flow
2. **Cloud hub waitlist** landing page (zero eng effort, validate demand)
3. **Demo video + Hacker News "Show HN" post** (product already looks impressive)

### Biggest Risk
Anthropic builds multi-instance coordination natively (12-18 month window). Mitigation: move fast, build community, differentiate on team/enterprise features.

---

## Suggested Execution Order

1. **C1** — Add hub auth (shared secret in lock file) + restrict CORS
2. **C2** — Lock down permission decide endpoint
3. **H1** — Bounded message history (cap per room)
4. **H3** — Context pollution reduction (deduplicate instructions)
5. **H4** — Default `get_messages` limit
6. **H7** — Fix hardcoded version
7. **M6** — Add `clear_session` to permissions
8. **M5** — Fix `get_task_status` (notes bug + efficiency)
9. **H6** — Dashboard WebSocket reconnection
10. **M2** — Wire dashboard to real-time WS events
11. **C3** — Harden project launch endpoint
12. **H5** — Split hub-server.ts god-file
13. Everything else
