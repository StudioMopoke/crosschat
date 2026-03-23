# CrossChat — Claude Code Development Guide

CrossChat is an MCP server for inter-instance Claude Code collaboration. It provides a hub-based unified messaging system where Claude Code instances connect via WebSocket and communicate through a persistent channel with threads and badges.

## Build & Run

- **Build:** `npm run build` (TypeScript → `dist/`)
- **Build all:** `npm run build:all` (includes dashboard)
- **Dev:** `npm run dev` (runs via tsx)
- **Start:** `npm run start` (runs compiled output)

## Project Structure

- `src/hub/` — Hub server: WebSocket connections, protocol, message manager
- `src/hub/message-manager.ts` — Persistent message storage, threads, badges, task operations
- `src/tools/` — MCP tool implementations (10 tools)
- `src/server.ts` — MCP server setup and tool registration
- `src/types.ts` — Shared type definitions
- `src/prompts.ts` — MCP prompt definitions
- `src/lifecycle.ts` — Instance lifecycle management
- `src/stores/` — Client-side message store
- `src/util/` — ID generation, logging, PID management
- `src/index.ts` — Entry point
- `dashboard/` — Vite frontend dashboard
- `bin/cli.cjs` — CLI entry point
- `hooks/` — Permission hook scripts

## Workflow Configuration

### Commands
| Command | Purpose |
|---------|---------|
| `/feature` | Specify **what** to build — feature spec, technical design, scope |
| `/discuss` | Plan **when/how** to execute — sprint planning, task scheduling, backlog |
| `/start` | Begin a task — fetch context, create branch, spawn zone agents. Use `/start auto` for autonomous mode (implement, verify, commit, push, PR, merge). |
| `/resume` | Continue after a break — reconstruct context from durable state |
| `/review` | Pre-PR self-review — evaluate changes against requirements |
| `/sync` | Pull latest and rebase current branch onto base branch |

### Task Management
- **Provider:** GitHub Issues
- **Repository:** StudioMopoke/crosschat

### Build & Test
- **Build command:** `npm run build`
- **Test command:** (none configured)

### Git Conventions
- **Branch format:** `{type}/{NUMBER}-short-name` (prefixes: `feature/`, `bugfix/`, `hotfix/`)
- **Commit format:** Conventional commits — `{type}({scope}): {description} (#{NUMBER})`
- **Default base branch:** `main`
- **AI marker:** None

### Agent Zones

| Zone | Paths | Triggers |
|------|-------|----------|
| **Hub Core** | `src/hub/` | Hub server, WebSocket, protocol, task management |
| **MCP Tools** | `src/tools/` | Tool implementations, new tools, tool modifications |
| **Server & Core** | `src/server.ts`, `src/types.ts`, `src/prompts.ts`, `src/lifecycle.ts`, `src/stores/`, `src/index.ts` | Type changes, server setup, prompts, lifecycle, message store |
| **Dashboard** | `dashboard/` | UI changes, dashboard features |
| **CLI & Hooks** | `bin/`, `hooks/` | CLI changes, hook modifications |

### Key Locations
- **Source:** `src/`
- **Dashboard frontend:** `dashboard/`
- **CLI:** `bin/cli.cjs`
- **Hooks:** `hooks/`
- **Scripts:** `scripts/` (workflow utility scripts)
- **Planning:** `planning/` (feature specs, sprint plans, backlog)
- **Keys:** `keys/` (GitHub App private key — never commit to git)

### External Dependencies
- **MCP Protocol:** This project implements the Model Context Protocol — changes must comply with the MCP specification

### GitHub Projects
- **Project number:** 6
- **Project owner:** StudioMopoke
- **Project ID:** PVT_kwDOC3YtY84BSbpL
- **Status field ID:** PVTSSF_lADOC3YtY84BSbpLzg_98ms
- **Status options:** `{"backlog": "f75ad846", "ready": "61e4505c", "in-progress": "47fc9ee4", "in-review": "df73e18b", "done": "98236657"}`

### Utility Scripts
- `scripts/issue.py` — Issue management (view, assign, unassign, label, unlabel)
- `scripts/next-issue.py` — Find next available task (`open` mode, `ready` mode with Projects)
- `scripts/project.py` — Project board operations (move, add, batch)
- `scripts/gh.py` — Run any `gh` CLI command with optional app token auth
- `scripts/gh_auth.py` — Shared token helper with caching (used by all scripts via `--app-token` flag)
- `scripts/gh_app_token.py` — Generate GitHub App installation tokens

### Planning
- **Feature specs:** `planning/features/{feature-name}/` (created by `/feature`)
- **Sprint plans:** `planning/sprints/sprint-{N}-{name}/` (created by `/discuss`)
- **Backlog:** `planning/backlog/`
