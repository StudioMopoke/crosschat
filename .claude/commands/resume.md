# /resume — Continue work after a session break

Continue work on a task already in progress. Reconstructs context from git state and durable planning docs.

If you need to start a new task from scratch, use `/start` instead.

## Input

Argument: `$ARGUMENTS` (optional — task ID or branch name to resume; if empty, detect from current branch)

## Step 1: Detect current work from git

Run in parallel:
- `git branch --show-current` — get current branch
- `git status --short` — check for uncommitted changes
- `git log --oneline -10` — recent commits on this branch
- `git diff --stat` — unstaged changes

Extract the task number from the branch name using pattern: `(feature|bugfix|hotfix)/(\d+)-.*` → capture group 2.

If no task ID found in branch name and `$ARGUMENTS` is provided, use it as the task ID. If still no task ID, ask the user.

## Step 2: Fetch task context

```bash
gh issue view {NUMBER} --repo StudioMopoke/crosschat --json number,title,state,labels,assignees,milestone,body
```

Extract: summary, description, status, AC, priority, labels.

## Step 3: Check progress

1. Check for existing planning docs:
   - Sprint task spec: search `planning/sprints/*/` for files referencing issue `{NUMBER}`
   - Per-task doc: check `planning/tasks/{NUMBER}.md`
   - Feature spec: check `planning/features/` for related features
2. If sprint task spec exists: read it, check which subtasks/phases are done. Read `COMPLETED.md` if it exists. Surface what's next.
3. If per-task doc exists: read approach and notes sections.
4. Check `git log main..HEAD --oneline` for what's been done on this branch.

## Step 4: Spawn exploration agents

Based on the task description, planning context, and files already changed, pick relevant agent zones and spawn in parallel with `run_in_background: true`:

| Zone | Paths | Triggers |
|------|-------|----------|
| **Hub Core** | `src/hub/` | Hub server changes, WebSocket, protocol, task management |
| **MCP Tools** | `src/tools/` | Tool implementations, new tools, tool modifications |
| **Server & Core** | `src/server.ts`, `src/types.ts`, `src/prompts.ts`, `src/lifecycle.ts`, `src/stores/`, `src/index.ts` | Type changes, server setup, prompts, lifecycle, message store |
| **Dashboard** | `dashboard/` | UI changes, dashboard features |
| **CLI & Hooks** | `bin/`, `hooks/` | CLI changes, hook modifications |

Focus agents on areas that have been modified or are relevant to remaining work.

## Step 5: Report status

Present:
- **Task:** #{NUMBER} — {title} ({state})
- **Branch:** {branch_name}
- **Git state:** {N} commits ahead of main, {uncommitted changes summary}
- **Planning progress:** what's done vs. what's remaining from the task spec
- **Running agents:** which zones are being explored
- **What to work on next:** based on remaining AC items and planning docs

## Step 6: Continue

Resume work based on the context gathered. Follow up on agent results as they complete.

**Reminders:**
- Commit format: `{type}({scope}): {description} (#{NUMBER})`
- Update planning docs as you make progress
- When done, run `/review` before creating a PR
