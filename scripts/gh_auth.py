#!/usr/bin/env python3
"""Shared GitHub App token helper for all workflow scripts.

Provides handle_app_token_flag() which strips --app-token from argv and,
when present, generates a GitHub App installation token and sets it as
GH_TOKEN in the environment. This gives a separate rate limit pool from
the user's personal token.

If gh_app_token.py is not present (GitHub App not configured), --app-token
prints a helpful message and continues using default gh CLI auth.

Caches tokens to /tmp/crosschat_gh_app_token.json with a 50-minute TTL
(tokens are valid for 60 minutes) to avoid redundant generation.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

CACHE_PATH = Path("/tmp/crosschat_gh_app_token.json")
CACHE_TTL = 50 * 60  # 50 minutes (tokens valid for 60)
TOKEN_SCRIPT = Path(__file__).resolve().parent / "gh_app_token.py"


def _is_app_configured():
    """Check whether gh_app_token.py exists (i.e., GitHub App is configured)."""
    return TOKEN_SCRIPT.exists()


def _read_cached_token():
    """Return cached token if valid, else None."""
    try:
        data = json.loads(CACHE_PATH.read_text())
        if data.get("expires_at", 0) > time.time():
            return data["token"]
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        pass
    return None


def _generate_and_cache_token():
    """Generate a fresh token, cache it, and return it."""
    result = subprocess.run([sys.executable, str(TOKEN_SCRIPT)],
                            capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error generating app token: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    token = result.stdout.strip()
    try:
        CACHE_PATH.write_text(json.dumps({
            "token": token,
            "expires_at": time.time() + CACHE_TTL,
        }))
        CACHE_PATH.chmod(0o600)
    except OSError:
        pass  # Non-fatal — caching is best-effort
    return token


def _get_token():
    """Return a valid app token, using cache when possible."""
    return _read_cached_token() or _generate_and_cache_token()


def setup_app_token():
    """Generate and set GH_TOKEN from the GitHub App."""
    os.environ["GH_TOKEN"] = _get_token()


def get_app_token():
    """Generate and return a GitHub App installation token string."""
    return _get_token()


def handle_app_token_flag(argv):
    """Strip --app-token from argv and set up token if present.

    Returns the filtered argv list (without --app-token).
    If --app-token is used but gh_app_token.py doesn't exist, prints
    a message explaining how to set up a GitHub App and continues
    using default gh CLI auth.
    """
    filtered = [a for a in argv if a != "--app-token"]
    if "--app-token" in argv:
        if _is_app_configured():
            setup_app_token()
        else:
            print("--app-token: GitHub App not configured. To enable:", file=sys.stderr)
            print("  1. Create a GitHub App at https://github.com/settings/apps", file=sys.stderr)
            print("  2. Grant it repo/project permissions and install on your org", file=sys.stderr)
            print("  3. Download the private key (.pem) into this repo", file=sys.stderr)
            print("     (*.pem is already in .gitignore — never commit private keys!)", file=sys.stderr)
            print("  4. pip install pyjwt cryptography", file=sys.stderr)
            print("  5. Re-run /bootstrap and say yes to 'GitHub App integration'", file=sys.stderr)
            print("  Falling back to default gh CLI auth.\n", file=sys.stderr)
    return filtered
