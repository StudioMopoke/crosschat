# /start — Begin work on a task

Begin work on a task: fetch context, create branch, spawn zone agents. Use `/start auto` for autonomous mode (implement, verify, commit, push, PR, merge).

If you need to continue work on a task already in progress, use `/resume` instead.

## Input

Argument: `$ARGUMENTS`

## Step 1: Parse argument

Parse the argument to determine the task and mode:

- **`auto [task]`** — Detect the `auto` keyword anywhere in the arguments. Strip it and set `AUTO_MODE=true`. The remaining argument is processed normally (task ID, URL, `next`, `rnext`, or empty). If empty in auto mode, treat as `next`.
- **`next`** — Auto-select the next task. Run `python scripts/next-issue.py` (defaults to `ready` when Projects is configured, `open` otherwise). Show the user which task was selected and ask for confirmation before proceeding (skip confirmation in auto mode).
- **`rnext`** or **`next ready`** — Select the next task from the "Ready" column. Run `python scripts/next-issue.py ready`. Show the user which task was selected and ask for confirmation (skip in auto mode).
- **Task ID** — A number or `#NUMBER` (e.g., `42` or `#42`).
- **URL** — A full GitHub issue URL (extract the number).
- **Empty or unrecognizable** — Ask the user for the task identifier. **NEVER guess or make up a task ID.**

## Step 2: Fetch task context

Run:
```bash
gh issue view {NUMBER} --repo StudioMopoke/crosschat --json number,title,state,labels,assignees,milestone,body
```

Extract: summary, description, status, acceptance criteria, priority, labels, linked issues.

## Step 3: Guard against duplicate work

Check `git branch -a` for existing branches matching this issue number (e.g., `feature/{NUMBER}-*`, `bugfix/{NUMBER}-*`, `hotfix/{NUMBER}-*`).

Check for existing planning docs at `planning/sprints/*/` or `planning/features/*/` referencing this issue.

If work exists:
- **Normal mode:** Suggest the user run `/resume` instead.
- **Auto mode:** Continue working (skip the `/resume` suggestion).

## Step 4: Create feature branch

1. Derive a short name from the task summary (lowercase, hyphens, 3-5 words max).
2. Determine the branch type prefix based on labels:
   - `bug` label → `bugfix/`
   - `hotfix` label → `hotfix/`
   - Otherwise → `feature/`
3. Create branch: `git checkout -b {type}/{NUMBER}-{short-name} main`

## Step 5: Load planning context

Read the active sprint overview if one exists in `planning/sprints/`. Find the relevant task spec if one exists. If a task spec exists in a sprint, surface its requirements, AC, files to create, and TDD specs.

If no task spec exists:
- **Normal mode:** Note that the user may want to run `/discuss` first or create one ad-hoc.
- **Auto mode:** Create a lightweight per-task doc at `planning/tasks/{NUMBER}.md` from the issue context.

## Step 6: Spawn exploration agents

Based on the task description and planning context, pick relevant agent zones and spawn exploration agents in parallel with `run_in_background: true`:

| Zone | Paths | Triggers |
|------|-------|----------|
| **Hub Core** | `src/hub/` | Hub server changes, WebSocket, protocol, task management |
| **MCP Tools** | `src/tools/` | Tool implementations, new tools, tool modifications |
| **Server & Core** | `src/server.ts`, `src/types.ts`, `src/prompts.ts`, `src/lifecycle.ts`, `src/stores/`, `src/index.ts` | Type changes, server setup, prompts, lifecycle, message store |
| **Dashboard** | `dashboard/` | UI changes, dashboard features |
| **CLI & Hooks** | `bin/`, `hooks/` | CLI changes, hook modifications |

Prompt each agent to explore its zone and report:
- Relevant existing code and patterns
- Integration points with the task
- Potential impacts of the change

## Step 7: Transition task status

1. Assign the issue: `python scripts/issue.py assign {NUMBER}`
2. Move on project board: `python scripts/project.py move {NUMBER} in-progress`

If the issue is not yet on the project board, add it first: `python scripts/project.py add {NUMBER} in-progress`

## Step 8: Report setup summary

Present:
- Task info (number, title, description, AC)
- Branch name
- Planning docs found/created
- Running agents and their zones
- Suggested approach based on what we know

**Normal mode:** Wait for the user before beginning implementation.
**Auto mode:** Immediately begin implementation without waiting.

---

## Auto Mode (steps 9-14, only when AUTO_MODE=true)

### Step 9: Verify

After implementation is complete, run automated checks:

**9a: Build check** — Run `npm run build`. If it fails, fix the issue and retry.

**9b: Requirements check** — Map each acceptance criterion from the task to the diff. Check that each AC is addressed by the changes.

**9c: Verdict** — If all checks pass, continue to step 10. If any check fails, attempt to fix and re-verify (up to 3 retries). If still failing after 3 retries, stop auto mode, report failures, and hand control back to the user.

### Step 10: Auto-commit

Stage the specific files that were changed (do NOT use `git add -A`). Commit with conventional commit format:

```
{type}({scope}): {description} (#{NUMBER})
```

### Step 11: Auto-push

```bash
git push -u origin {branch_name}
```

### Step 12: Auto-create PR

Create a pull request:
```bash
gh pr create --repo StudioMopoke/crosschat --title "{type}({scope}): {description}" --body "..."
```

Include in the PR body:
- Summary of what was implemented
- Acceptance criteria as a checklist (with checkmarks for verified items)
- `Closes #{NUMBER}`

### Step 13: Auto-merge

```bash
gh pr merge --squash --delete-branch
```

If merge fails (branch protection, required reviews), report failure and leave PR open.

Update project board: `python scripts/project.py move {NUMBER} done`

### Step 14: Completion report

Display:
- Task: `#{NUMBER} — {title}`
- Branch: `{branch_name}`
- Files changed with brief descriptions
- Verification results: build, requirements check status
- PR link
- Suggest: `/start auto next` to continue with the next task
