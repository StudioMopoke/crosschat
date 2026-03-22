#!/usr/bin/env python3
"""Generate a GitHub App installation token for the StudioMopoke org.

Usage:
  python scripts/gh_app_token.py              # prints token to stdout
  python scripts/gh_app_token.py --env        # prints GH_TOKEN=<token> for eval

The token is generated from the GitHub App private key and is valid for 1 hour.
Uses the App to get a separate rate limit pool from the user's personal token.

Requirements: pyjwt, cryptography (pip install pyjwt cryptography)
"""
import json
import subprocess
import sys
import time
from pathlib import Path

APP_ID = "2903181"
# Stable installation ID for StudioMopoke org. Refresh via:
#   curl -H "Authorization: Bearer <jwt>" https://api.github.com/app/installations
INSTALLATION_ID = "111199744"
KEY_PATH = Path(__file__).resolve().parent.parent / "keys" / "project-management-ci.2026-02-19.private-key.pem"


def generate_token():
    try:
        import jwt
    except ImportError:
        print("Error: pyjwt not installed. Run: pip install pyjwt cryptography",
              file=sys.stderr)
        sys.exit(1)

    if not KEY_PATH.exists():
        print(f"Error: Private key not found at {KEY_PATH}", file=sys.stderr)
        sys.exit(1)

    private_key = KEY_PATH.read_text()

    # Generate JWT
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + (10 * 60), "iss": APP_ID}
    jwt_token = jwt.encode(payload, private_key, algorithm="RS256")

    # Generate installation access token
    r2 = subprocess.run([
        "curl", "-s", "-X", "POST",
        "-H", f"Authorization: Bearer {jwt_token}",
        "-H", "Accept: application/vnd.github+json",
        f"https://api.github.com/app/installations/{INSTALLATION_ID}/access_tokens"
    ], capture_output=True, text=True)
    token_data = json.loads(r2.stdout)
    if "token" not in token_data:
        print(f"Error: {json.dumps(token_data)}", file=sys.stderr)
        sys.exit(1)

    return token_data["token"]


def main():
    token = generate_token()
    if "--env" in sys.argv:
        print(f"GH_TOKEN={token}")
    else:
        print(token)


if __name__ == "__main__":
    main()
