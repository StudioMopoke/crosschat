# /review — Pre-PR self-review

Evaluate changes against requirements and acceptance criteria. This is for pre-PR self-review — not a replacement for team code review, but helps catch issues before involving reviewers.

## Input

Argument: `$ARGUMENTS` (optional — base branch override; defaults to `main`)

## Step 1: Detect current work

Run in parallel:
- `git branch --show-current` — current branch
- `git status --short` — uncommitted changes
- `git log main..HEAD --oneline` — commits on this branch
- `git diff main...HEAD --stat` — files changed vs. main
- `git remote` — verify remote exists

Extract task number from branch: `(feature|bugfix|hotfix)/(\d+)-.*` → capture group 2.

## Step 2: Gather requirements

Collect everything about what this task should accomplish:

1. **GitHub Issue:** `gh issue view {NUMBER} --repo StudioMopoke/crosschat --json number,title,state,labels,assignees,milestone,body`
2. **Sprint task spec:** Search `planning/sprints/*/` for files referencing issue `{NUMBER}`
3. **Per-task doc:** Check `planning/tasks/{NUMBER}.md`
4. **Feature spec:** Check `planning/features/` for related features

Extract acceptance criteria from all sources.

## Step 3: Collect all changes

Build a complete picture:
- `git log main..HEAD --oneline` — all commits on branch
- `git diff main...HEAD` — full diff
- `git diff main...HEAD --stat` — file change summary
- `git diff` + `git diff --cached` — any uncommitted changes (note separately)

## Step 4: Spawn deep review agents

For each major area of change, spawn an exploration agent to understand surrounding code context:

| Zone | Paths | When to spawn |
|------|-------|---------------|
| **Hub Core** | `src/hub/` | Changes touch hub server, protocol, connections |
| **MCP Tools** | `src/tools/` | Changes touch tool implementations |
| **Server & Core** | `src/server.ts`, `src/types.ts`, `src/prompts.ts`, `src/lifecycle.ts`, `src/stores/`, `src/index.ts` | Changes touch core types, server setup |
| **Dashboard** | `dashboard/` | Changes touch frontend |
| **CLI & Hooks** | `bin/`, `hooks/` | Changes touch CLI or hooks |

Prompt agents to report: how the changed code interacts with surrounding code, potential side effects, patterns that should be followed.

## Step 5: Conduct the review

Evaluate changes against requirements. Check for:

- **Completeness:** Are all acceptance criteria addressed? Any requirements missed?
- **Correctness:** Logic errors, edge cases, off-by-one errors, null/undefined handling.
- **Security:** Injection risks, auth/authz gaps, secrets in code, OWASP top 10.
- **Performance:** Unbounded loops, missing pagination, unnecessary allocations, WebSocket message flooding.
- **Error handling:** Unhappy paths covered? Errors propagated correctly? User-facing messages helpful?
- **Tests:** Are new/changed paths tested? Any obvious coverage gaps?
- **Style & consistency:** Does the code follow existing patterns in the codebase? Naming conventions, file organization, abstraction level.
- **MCP protocol compliance:** Do changes align with the MCP protocol specification?

## Step 6: Report findings

Present a structured review:

```
## Review: #{NUMBER} — {title}

### Summary
{One-paragraph overview of what the changes do}

### Requirements Checklist
- [x] {AC item — pass}
- [ ] {AC item — fail/partial}

### Issues Found
#### Blocking
- **{file}:{line}** — {description}. Suggested fix: {fix}

#### Warning
- **{file}:{line}** — {description}

#### Nit
- **{file}:{line}** — {description}

### What Looks Good
- {Highlight well-implemented parts}

### Suggestions
- {Optional improvements, not blocking}
```

## Step 7: Offer next steps

Based on findings:
- **Blocking issues found:** Offer to fix them now.
- **Clean review:** Offer to create a PR. If uncommitted changes exist, offer to commit first.
  - Commit format: `{type}({scope}): {description} (#{NUMBER})`
  - PR creation: `gh pr create --repo StudioMopoke/crosschat --title "..." --body "..."`
- **Task management:** Offer to move issue to "In review": `python scripts/project.py move {NUMBER} in-review`
