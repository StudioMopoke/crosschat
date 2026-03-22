#!/usr/bin/env python3
"""Print the next 3 issues to work on that don't have branches yet.

Usage:
  python scripts/next-issue.py ready   # From project board "Ready" column (default)
  python scripts/next-issue.py open    # From open unassigned issues

Options:
  --app-token    Use GitHub App token (avoids personal rate limits)
"""
import json, subprocess, re, sys

from gh_auth import handle_app_token_flag

REPO = "StudioMopoke/crosschat"
PROJECT_NUM = 6
PROJECT_OWNER = "StudioMopoke"

args = handle_app_token_flag(sys.argv[1:])
default_mode = "ready" if PROJECT_NUM else "open"
mode = args[0] if args else default_mode

branches = subprocess.check_output(["git", "branch", "-a"], text=True, encoding="utf-8")
taken = {int(m) for m in re.findall(r"/(\d+)-", branches)}

if mode == "ready":
    if not PROJECT_NUM:
        print("GitHub Projects not configured. Use 'open' mode instead.")
        sys.exit(2)
    board = json.loads(subprocess.check_output(
        ["gh", "project", "item-list", str(PROJECT_NUM), "--owner", PROJECT_OWNER,
         "--format", "json", "--limit", "200"],
        text=True, encoding="utf-8"
    ))
    candidates = sorted(
        (i["content"]["number"], i["content"]["title"])
        for i in board["items"]
        if i.get("status") == "Ready" and i["content"]["number"] not in taken
    )
    empty_msg = "No Ready issues without branches."
elif mode == "open":
    issues = json.loads(subprocess.check_output(
        ["gh", "issue", "list", "--repo", REPO, "--state", "open",
         "--json", "number,title,assignees", "--limit", "50"],
        text=True, encoding="utf-8"
    ))
    candidates = sorted(
        (i["number"], i["title"])
        for i in issues
        if not i.get("assignees") and i["number"] not in taken
    )
    empty_msg = "No open unassigned issues without branches."
else:
    print(f"Unknown mode: {mode}. Use 'open' or 'ready'.")
    sys.exit(2)

if not candidates:
    print(empty_msg)
    sys.exit(1)

for num, title in candidates[:3]:
    print(f"#{num} -- {title}")
