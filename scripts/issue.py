#!/usr/bin/env python3
"""Common GitHub issue operations.

Usage:
  python scripts/issue.py view <issue_num>         # Show issue summary
  python scripts/issue.py assign <issue_num>       # Assign to yourself
  python scripts/issue.py unassign <issue_num>     # Remove your assignment
  python scripts/issue.py label <issue_num> <label> [<label> ...]   # Add labels
  python scripts/issue.py unlabel <issue_num> <label> [<label> ...]  # Remove labels

Options:
  --app-token    Use GitHub App token (avoids personal rate limits)
"""
import json, os, subprocess, sys

from gh_auth import handle_app_token_flag

REPO = "StudioMopoke/crosschat"


def gh(*args, json_output=False):
    cmd = ["gh"] + list(args)
    env = None
    if os.environ.get("GH_TOKEN"):
        env = {**os.environ}
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env=env)
    if result.returncode != 0:
        print(f"Error: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    if json_output:
        return json.loads(result.stdout)
    return result.stdout.strip()


def cmd_view(issue_num):
    data = gh("issue", "view", str(issue_num), "--repo", REPO,
              "--json", "number,title,state,labels,assignees,milestone,body",
              json_output=True)
    labels = ", ".join(l["name"] for l in data.get("labels", [])) or "(none)"
    assignees = ", ".join(a["login"] for a in data.get("assignees", [])) or "(none)"
    milestone = (data.get("milestone") or {}).get("title", "(none)")
    print(f"#{data['number']} - {data['title']}")
    print(f"  State:     {data['state']}")
    print(f"  Labels:    {labels}")
    print(f"  Assignees: {assignees}")
    print(f"  Milestone: {milestone}")
    body = data.get("body", "").strip()
    if body:
        print(f"\n{body}")


def cmd_assign(issue_num):
    gh("issue", "edit", str(issue_num), "--repo", REPO, "--add-assignee", "@me")
    print(f"#{issue_num} assigned to you.")


def cmd_unassign(issue_num):
    gh("issue", "edit", str(issue_num), "--repo", REPO, "--remove-assignee", "@me")
    print(f"#{issue_num} unassigned from you.")


def cmd_label(issue_num, labels):
    label_args = []
    for label in labels:
        label_args += ["--add-label", label]
    gh("issue", "edit", str(issue_num), "--repo", REPO, *label_args)
    print(f"#{issue_num} labels added: {', '.join(labels)}")


def cmd_unlabel(issue_num, labels):
    label_args = []
    for label in labels:
        label_args += ["--remove-label", label]
    gh("issue", "edit", str(issue_num), "--repo", REPO, *label_args)
    print(f"#{issue_num} labels removed: {', '.join(labels)}")


def main():
    args = handle_app_token_flag(sys.argv[1:])

    if len(args) < 2:
        print(__doc__.strip())
        sys.exit(2)

    command = args[0]
    issue_num = int(args[1].lstrip("#"))

    if command == "view":
        cmd_view(issue_num)
    elif command == "assign":
        cmd_assign(issue_num)
    elif command == "unassign":
        cmd_unassign(issue_num)
    elif command == "label":
        remaining = args[2:]
        if not remaining:
            print("Usage: issue.py label <issue_num> <label> [<label> ...]")
            sys.exit(2)
        cmd_label(issue_num, remaining)
    elif command == "unlabel":
        remaining = args[2:]
        if not remaining:
            print("Usage: issue.py unlabel <issue_num> <label> [<label> ...]")
            sys.exit(2)
        cmd_unlabel(issue_num, remaining)
    else:
        print(f"Unknown command '{command}'. Use: view, assign, unassign, label, unlabel")
        sys.exit(2)


if __name__ == "__main__":
    main()
