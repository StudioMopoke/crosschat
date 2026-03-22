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

# ── Opt-in gate — only crosschat-connected sessions trigger this ──

if [ -n "${CROSSCHAT_AGENT_NAME:-}" ]; then
  AGENT_NAME="$CROSSCHAT_AGENT_NAME"
elif [ -f "$HOME/.crosschat/sessions/$PPID" ]; then
  # MCP-connected instance — read agent name from session marker
  AGENT_NAME=$(jq -r '.name // empty' "$HOME/.crosschat/sessions/$PPID" 2>/dev/null)
  if [ -z "$AGENT_NAME" ]; then
    exit 0  # Marker exists but unreadable — fall through
  fi
else
  exit 0  # Not a crosschat agent — fall through to normal permissions
fi

# ── Resolve hub URL ───────────────────────────────────────────────

LOCK_FILE="$HOME/.crosschat/dashboard.lock"

if [ -n "${CROSSCHAT_HUB_URL:-}" ]; then
  HUB_URL="$CROSSCHAT_HUB_URL"
elif [ -f "$LOCK_FILE" ]; then
  PORT=$(jq -r '.port' "$LOCK_FILE" 2>/dev/null)
  if [ -n "$PORT" ] && [ "$PORT" != "null" ]; then
    HUB_URL="http://localhost:${PORT}"
  else
    exit 0  # No hub running — fall through to normal permissions
  fi
else
  exit 0  # No lock file — fall through to normal permissions
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

# ── Check existing Claude Code permissions ────────────────────────
# Skip the dashboard for tools already allowed in settings files.

get_tool_input_value() {
  case "$TOOL_NAME" in
    Bash)            echo "$TOOL_INPUT" | jq -r '.command // empty' ;;
    Read|Write|Edit) echo "$TOOL_INPUT" | jq -r '.file_path // empty' ;;
    Glob)            echo "$TOOL_INPUT" | jq -r '.pattern // empty' ;;
    Grep)            echo "$TOOL_INPUT" | jq -r '.pattern // empty' ;;
    *)               echo "" ;;
  esac
}

is_allowed_by() {
  local settings_file="$1"
  [ -f "$settings_file" ] || return 1

  local rules
  rules=$(jq -r '(.permissions.allow // [])[]' "$settings_file" 2>/dev/null) || return 1
  [ -z "$rules" ] && return 1

  local input_value
  input_value=$(get_tool_input_value)

  while IFS= read -r rule; do
    [ -z "$rule" ] && continue

    if [[ "$rule" =~ ^([A-Za-z_:]+)\((.+)\)$ ]]; then
      # Pattern rule: ToolName(glob-pattern)
      if [ "${BASH_REMATCH[1]}" = "$TOOL_NAME" ] && [ -n "$input_value" ] && [[ "$input_value" == ${BASH_REMATCH[2]} ]]; then
        return 0
      fi
    elif [ "$rule" = "$TOOL_NAME" ]; then
      # Bare tool name — allow all uses
      return 0
    fi
  done <<< "$rules"

  return 1
}

if is_allowed_by "$HOME/.claude/settings.json" || \
   is_allowed_by ".claude/settings.json" || \
   is_allowed_by ".claude/settings.local.json"; then
  exit 0  # Already permitted — fall through to normal flow
fi

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
  exit 0  # Failed to create — fall through to normal permissions
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
    # Return deny decision (use jq to safely encode the reason into JSON)
    jq -n --arg reason "$REASON" \
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
    exit 0
  fi

  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done

# Timed out — allow by default
exit 0
