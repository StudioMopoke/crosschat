# /sync — Pull latest and rebase onto main

Pull latest changes and rebase current branch onto the base branch.

## Safety Rules — HARD REQUIREMENTS

- **NEVER** run `git push --force`, `git push --force-with-lease`, or any force push variant
- **NEVER** run `git reset --hard`, `git clean -f`, `git checkout .`, or `git restore .`
- **NEVER** delete branches
- If anything goes wrong, abort the rebase and tell the user

## Step 1: Gather current state

Run in parallel:
- `git branch --show-current`
- `git status --short`
- `git remote`

## Step 2: Commit uncommitted changes if needed

If there are uncommitted changes (staged or unstaged, but NOT untracked-only):
1. Show the user the changes: `git diff --stat` and `git diff --cached --stat`
2. Stage modified/deleted files: `git add -u`
3. Stage new files that look like project code (not build artifacts, `.env`, etc.)
4. Commit with conventional format:
   ```
   chore: save work in progress before sync
   ```

If the working tree is clean (or only untracked files), continue.

## Step 3: Sync the branch

**On `main` branch:**
```bash
git pull --rebase origin main
```

**On a feature branch:**
```bash
git fetch origin main && git rebase origin/main
```

## Step 4: Conflict resolution

When `git rebase` stops due to conflicts:

1. List conflicted files: `git diff --name-only --diff-filter=U`
2. For each conflicted file:
   - Read the file to understand both sides
   - Resolve intelligently:
     - Superset wins (combine independent changes)
     - Prefer main for structural changes
     - Ask user for ambiguous cases
   - Stage resolved file: `git add {file}`
3. Continue rebase: `git rebase --continue`
4. If conflicts are too complex, abort: `git rebase --abort` and report to user

## Step 5: Report results

Show:
- Branch name
- Whether new commits were pulled/rebased
- Conflict resolution summary (if any)
- Current status: `git status --short`
