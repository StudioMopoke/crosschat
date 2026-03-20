#!/usr/bin/env bash
# CrossChat Permission Hook for Claude Code
#
# Elevates Claude Code permission requests to the CrossChat dashboard.
# The script POSTs the request to the hub, then polls until the user
# approves or denies it from the dashboard UI.
#
# Setup — add to your Claude Code settings (~/.claude/settings.json):
#
#   "hooks": {
#     "PreToolUse": [{
#       "matcher": "",
#       "hooks": [{
#         "type": "command",
#         "command": "/path/to/crosschat/hooks/permission-hook.sh",
#         "timeout": 300
#       }]
#     }]
#   }
#
# Requires: curl, jq
# Env: CROSSCHAT_HUB_URL (default: auto-detected from ~/.crosschat/dashboard.lock)

set -euo pipefail

# ── Resolve hub URL ───────────────────────────────────────────────

LOCK_FILE="$HOME/.crosschat/dashboard.lock"

if [ -n "${CROSSCHAT_HUB_URL:-}" ]; then
  HUB_URL="$CROSSCHAT_HUB_URL"
elif [ -f "$LOCK_FILE" ]; then
  PORT=$(jq -r '.port' "$LOCK_FILE" 2>/dev/null)
  if [ -n "$PORT" ] && [ "$PORT" != "null" ]; then
    HUB_URL="http://localhost:${PORT}"
  else
    exit 0  # No hub running — allow silently
  fi
else
  exit 0  # No lock file — allow silently
fi

# ── Read hook input from stdin ────────────────────────────────────

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Skip if no tool name
if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
DESCRIPTION=$(echo "$INPUT" | jq -r '.tool_input.description // empty')

# Try to find agent name from env or generate from session
AGENT_NAME="${CROSSCHAT_AGENT_NAME:-claude-$(echo "${INPUT}" | jq -r '.session_id // "unknown"' | cut -c1-4)}"

# ── POST permission request to hub ────────────────────────────────

RESPONSE=$(curl -s -X POST "${HUB_URL}/api/permissions" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg agentName "$AGENT_NAME" \
    --arg toolName "$TOOL_NAME" \
    --argjson toolInput "$TOOL_INPUT" \
    --arg description "$DESCRIPTION" \
    '{agentName: $agentName, toolName: $toolName, toolInput: $toolInput, description: $description}'
  )" 2>/dev/null) || exit 0

PERM_ID=$(echo "$RESPONSE" | jq -r '.id // empty')
if [ -z "$PERM_ID" ]; then
  exit 0  # Failed to create — allow silently
fi

# ── Poll for decision ─────────────────────────────────────────────

MAX_WAIT=300  # 5 minutes
ELAPSED=0
INTERVAL=1

while [ $ELAPSED -lt $MAX_WAIT ]; do
  RESULT=$(curl -s "${HUB_URL}/api/permissions/${PERM_ID}" 2>/dev/null) || break
  STATUS=$(echo "$RESULT" | jq -r '.status // "pending"')

  if [ "$STATUS" = "approved" ]; then
    # Return allow decision
    cat <<ALLOW_EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Approved via CrossChat dashboard"}}
ALLOW_EOF
    exit 0
  elif [ "$STATUS" = "denied" ]; then
    REASON=$(echo "$RESULT" | jq -r '.reason // "Denied via CrossChat dashboard"')
    # Return deny decision
    cat <<DENY_EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"$REASON"}}
DENY_EOF
    exit 0
  fi

  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done

# Timed out — allow by default
exit 0
