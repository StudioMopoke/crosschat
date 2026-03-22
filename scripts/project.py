#!/usr/bin/env python3
"""Manage GitHub project board items for the CrossChat project.

Usage:
  python scripts/project.py move  <issue_num> <status>
  python scripts/project.py add   <issue_num> [<status>]
  python scripts/project.py batch <issue_nums...> <status>

Options:
  --app-token    Use GitHub App token (avoids personal rate limits for bulk ops)

Statuses: backlog, ready, in-progress, in-review, done

Examples:
  python scripts/project.py move 4 in-progress
  python scripts/project.py add 4 ready
  python scripts/project.py batch 42 43 44 ready --app-token
"""
import json, os, subprocess, sys

from gh_auth import handle_app_token_flag

PROJECT_NUM = 6
PROJECT_OWNER = "StudioMopoke"
REPO = "StudioMopoke/crosschat"

PROJECT_ID = "PVT_kwDOC3YtY84BSbpL"
STATUS_FIELD_ID = "PVTSSF_lADOC3YtY84BSbpLzg_98ms"

STATUS_OPTIONS = {
    "backlog":     "f75ad846",
    "ready":       "61e4505c",
    "in-progress": "47fc9ee4",
    "in-review":   "df73e18b",
    "done":        "98236657",
}


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


def fetch_board():
    """Fetch the full project board (up to 200 items)."""
    return gh("project", "item-list", str(PROJECT_NUM), "--owner", PROJECT_OWNER,
              "--format", "json", "--limit", "200", json_output=True)


def find_item_id_in_board(board, issue_num):
    """Find the project item ID for an issue in a pre-fetched board."""
    for item in board.get("items", []):
        content = item.get("content", {})
        if content.get("number") == issue_num:
            return item["id"]
    return None


def find_item_id(issue_num):
    """Find the project item ID for an issue already on the board."""
    board = fetch_board()
    return find_item_id_in_board(board, issue_num)


def add_item(issue_num):
    """Add an issue to the project board, returning the item ID."""
    url = f"https://github.com/{REPO}/issues/{issue_num}"
    result = gh("project", "item-add", str(PROJECT_NUM), "--owner", PROJECT_OWNER,
                "--url", url, "--format", "json", json_output=True)
    return result["id"]


def set_status(item_id, status):
    """Set the status field on a project item."""
    option_id = STATUS_OPTIONS[status]
    gh("project", "item-edit", "--project-id", PROJECT_ID,
       "--id", item_id, "--field-id", STATUS_FIELD_ID,
       "--single-select-option-id", option_id)


def cmd_move(issue_num, status):
    item_id = find_item_id(issue_num)
    if not item_id:
        print(f"Issue #{issue_num} not found on project board. Use 'add' first.")
        sys.exit(1)
    set_status(item_id, status)
    print(f"#{issue_num} -> {status}")


def cmd_add(issue_num, status=None):
    item_id = find_item_id(issue_num)
    if item_id:
        print(f"#{issue_num} already on board.")
    else:
        item_id = add_item(issue_num)
        print(f"#{issue_num} added to board.")
    if status:
        set_status(item_id, status)
        print(f"#{issue_num} -> {status}")


def cmd_batch(issue_nums, status):
    """Add multiple issues to the board with a status.

    Fetches the board once and reuses cached data to minimize API calls.
    """
    board = fetch_board()
    for issue_num in issue_nums:
        item_id = find_item_id_in_board(board, issue_num)
        if item_id:
            print(f"#{issue_num} already on board.")
        else:
            item_id = add_item(issue_num)
            print(f"#{issue_num} added to board.")
        set_status(item_id, status)
        print(f"#{issue_num} -> {status}")


def main():
    args = handle_app_token_flag(sys.argv[1:])

    if len(args) < 2:
        print(__doc__.strip())
        sys.exit(2)

    command = args[0]

    if command == "move":
        issue_num = int(args[1].lstrip("#"))
        if len(args) < 3:
            print("Usage: project.py move <issue_num> <status>")
            sys.exit(2)
        status = args[2]
        if status not in STATUS_OPTIONS:
            print(f"Unknown status '{status}'. Options: {', '.join(STATUS_OPTIONS)}")
            sys.exit(2)
        cmd_move(issue_num, status)
    elif command == "add":
        issue_num = int(args[1].lstrip("#"))
        status = args[2] if len(args) > 2 else None
        if status and status not in STATUS_OPTIONS:
            print(f"Unknown status '{status}'. Options: {', '.join(STATUS_OPTIONS)}")
            sys.exit(2)
        cmd_add(issue_num, status)
    elif command == "batch":
        if len(args) < 3:
            print("Usage: project.py batch <issue_nums...> <status>")
            sys.exit(2)
        status = args[-1]
        if status not in STATUS_OPTIONS:
            print(f"Unknown status '{status}'. Options: {', '.join(STATUS_OPTIONS)}")
            sys.exit(2)
        issue_nums = [int(a.lstrip("#")) for a in args[1:-1]]
        cmd_batch(issue_nums, status)
    else:
        print(f"Unknown command '{command}'. Use 'move', 'add', or 'batch'.")
        sys.exit(2)


if __name__ == "__main__":
    main()
