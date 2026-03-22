#!/usr/bin/env python3
"""Run any gh CLI command with optional GitHub App token authentication.

Usage:
  python scripts/gh.py [--app-token] <gh subcommand and args...>

Examples:
  python scripts/gh.py --app-token issue view 42 --repo StudioMopoke/crosschat
  python scripts/gh.py --app-token pr create --repo StudioMopoke/crosschat --title "Fix" --body "..."
  python scripts/gh.py --app-token pr merge 123 --repo StudioMopoke/crosschat --squash
  python scripts/gh.py issue comment 42 --repo StudioMopoke/crosschat --body "Done"

Options:
  --app-token    Use GitHub App token (avoids personal rate limits)

Without --app-token, uses whatever auth gh CLI has configured (personal token).
"""
import subprocess
import sys

from gh_auth import handle_app_token_flag


def main():
    args = handle_app_token_flag(sys.argv[1:])

    if not args:
        print(__doc__.strip())
        sys.exit(2)

    result = subprocess.run(["gh"] + args)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
