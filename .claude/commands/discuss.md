# /discuss — Sprint planning and task scheduling

Plan **when** and **how** to execute work: sprint planning, task scheduling, and backlog management. For specifying **what** to build, use `/feature` instead.

## Input

Argument: `$ARGUMENTS` (sprint name/number, task ID, or topic — if empty, ask what to plan)

## Step 1: Parse argument

Determine what to plan:
- **Sprint number** (e.g., `1`, `sprint-1`) — Plan or review that sprint
- **Task ID** (e.g., `#42`, `42`) — Discuss implementation approach for a specific task
- **Topic** (e.g., `backlog`, `priorities`, `next sprint`) — Freeform planning discussion
- **Empty** — Ask the user what they want to plan

## Step 2: Gather context

Read existing planning docs in parallel:
- `planning/sprints/` — existing sprint directories and overviews
- `planning/features/` — feature specs that provide task breakdowns, dependencies, scope
- `planning/backlog/` — parked items
- `planning/01_features.md` — project feature overview

Fetch relevant context from GitHub:
- Open issues: `gh issue list --repo StudioMopoke/crosschat --state open --json number,title,labels,assignees,milestone --limit 50`
- Project board: `gh project item-list 6 --owner StudioMopoke --format json --limit 200`

Check git history for recent activity: `git log --oneline -20`

## Step 3: Plan based on context

### If planning a sprint:

1. Check `planning/features/` for feature specs that provide task breakdowns and dependencies.
2. Review open issues and project board state.
3. Propose sprint scope: which tasks to include, in what order, with what dependencies.
4. For each task, define:
   - Requirements and acceptance criteria
   - Files likely to create/modify
   - Dependencies on other tasks
   - Estimated complexity (S/M/L)
5. If TDD is applicable, create test specifications per task/phase.

Create sprint directory structure:
```
planning/sprints/sprint-{N}-{name}/
├── 00_sprint_overview.md    # Sprint goal, task table, success criteria, out of scope
├── {NN}_{task}.md           # Detailed task specs
├── COMPLETED.md             # Progress tracking
└── tdd/
    ├── README.md            # TDD overview
    └── phase-{NN}-{name}.md # Test specifications per task
```

### If discussing a specific task:

1. Fetch the issue details from GitHub.
2. Read any existing planning docs for the task.
3. Discuss implementation approach interactively.
4. If in a sprint, update the task spec with decisions.
5. If standalone, create/update a per-task planning doc.

### If managing backlog:

1. Review `planning/backlog/` items.
2. Review open issues not assigned to sprints.
3. Help the user prioritize, park, or pull items.
4. Update backlog docs and project board as needed.

## Step 4: Leverage feature specs

When planning a sprint, always check `planning/features/` for feature specs first. These provide:
- Pre-defined task breakdowns in `scope.md`
- Technical design decisions in `technical-design.md`
- Dependencies and ordering constraints

Use these as input rather than re-deriving requirements from scratch.

## Step 5: Explore as needed

Spawn exploration agents to answer codebase questions that arise during planning. Use the zone definitions:

| Zone | Paths |
|------|-------|
| **Hub Core** | `src/hub/` |
| **MCP Tools** | `src/tools/` |
| **Server & Core** | `src/server.ts`, `src/types.ts`, `src/prompts.ts`, `src/lifecycle.ts`, `src/stores/`, `src/index.ts` |
| **Dashboard** | `dashboard/` |
| **CLI & Hooks** | `bin/`, `hooks/` |

## Step 6: Produce artifacts

Write sprint overviews, task specs, TDD specs, or backlog items. **Always ask before creating files.**

## Step 7: Offer next steps

- Suggest `/start {NUMBER}` to begin the first task
- Suggest `/feature` if requirements need to be specified first
- Suggest `/start auto next` for autonomous task execution
- Offer to create GitHub Issues from the task breakdown: `gh issue create --repo StudioMopoke/crosschat --title "..." --body "..."`
- Offer to add issues to the project board: `python scripts/project.py batch {NUMBERS} ready`
