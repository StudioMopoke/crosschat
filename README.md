# CrossChat

CrossChat is an MCP server that lets multiple Claude Code instances discover each other, communicate, and collaborate — all on a single machine. It uses a central hub with room-based messaging, a real-time web dashboard, and a structured task system.

## How it works

Each Claude Code instance runs CrossChat as an MCP server (via stdio). On startup, CrossChat ensures a shared hub server is running, then connects to it over WebSocket. All communication flows through the hub — there is no direct peer-to-peer messaging.

```
┌─────────────┐       stdio (MCP)       ┌──────────────┐
│ Claude Code  │ ◄────────────────────► │  CrossChat A  │──┐
│ Instance A   │                         │  (MCP server) │  │
└─────────────┘                         └──────────────┘  │
                                                           │ WebSocket
┌─────────────┐       stdio (MCP)       ┌──────────────┐  │
│ Claude Code  │ ◄────────────────────► │  CrossChat B  │──┤
│ Instance B   │                         │  (MCP server) │  │
└─────────────┘                         └──────────────┘  │
                                                           │
┌─────────────┐                         ┌──────────────┐  │
│   Browser    │ ◄──── WebSocket ─────► │   Hub Server  │◄─┘
│  Dashboard   │                         │  (HTTP + WS)  │
└─────────────┘                         └──────────────┘
```

**Hub server** — a single Node.js process that manages rooms, routes messages, tracks peers, and serves the dashboard. Spawned automatically by the first CrossChat instance; subsequent instances connect to the existing hub.

**Peer discovery** — agents register with the hub on connect. `list_peers` returns all connected agents with their name, status, working directory, and current room.

**Room-based messaging** — all messages go to a room (default: "general"). Agents can create rooms, join rooms, and use @mentions for targeted delivery.

**Task system** — structured task delegation with a full lifecycle: delegate → claim → accept → update → complete. Tasks persist across hub restarts and support markdown in updates and results.

**Dashboard** — a real-time web UI for monitoring agent activity, sending messages, managing projects, and approving permission requests.

---

## Setup

### Prerequisites

- Node.js 20+
- Claude Code with MCP support

### Install from npm

```bash
npm install -g @studiomopoke/crosschat
```

Then run the CLI to configure Claude Code:

```bash
crosschat install
```

This adds CrossChat to your MCP configuration and installs the permission elevation hook.

### Install from source

```bash
git clone https://github.com/StudioMopoke/crosschat.git
cd crosschat
npm install
npm run build
```

### Configure Claude Code

Add CrossChat to your MCP configuration (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "crosschat": {
      "command": "node",
      "args": ["/path/to/crosschat/dist/index.js"]
    }
  }
}
```

Optionally set a custom name or working directory:

```json
{
  "mcpServers": {
    "crosschat": {
      "command": "node",
      "args": ["/path/to/crosschat/dist/index.js"],
      "env": {
        "CROSSCHAT_NAME": "frontend-worker",
        "CROSSCHAT_CWD": "/path/to/project"
      }
    }
  }
}
```

If `CROSSCHAT_NAME` is omitted, a name is auto-generated from the working directory (e.g., `myproject-a1b2`).

---

## Using CrossChat

Once configured, CrossChat starts automatically with each Claude Code session. To begin collaborating, run `/crosschat` in any Claude Code instance. This:

1. Discovers connected peers
2. Sets up a background message listener
3. Announces the instance to the room
4. Shows the dashboard URL

From there, you can ask Claude to message peers, delegate tasks, switch rooms, or check status — all through natural language.

### Example

**Terminal 1:**
```
You: /crosschat

Claude: CrossChat is live. You are frontend-a1b2 in room "general".
  Peers: api-worker-c3d4 (available), backend-e5f6 (available)
  Dashboard: http://localhost:49322

You: Ask the other instances to run their test suites

Claude: Delegated tasks to api-worker and backend. Listening for results...

Claude: api-worker completed: 18 tests passed, 0 failed.
Claude: backend completed: 42 tests passed, 2 failed (auth_middleware, rate_limiter).
```

**Terminal 2:**
```
You: /crosschat

Claude: Connected as api-worker-c3d4. Listening for messages.

Claude: Received task from frontend-a1b2: "Run the test suite and report results"
  Working on it now...
  All 18 tests passed. Sent results back.
```

### @mentions

- **`@agent-name`** — delivers only to that agent
- **`@here`** — delivers to everyone in the room
- **No mention** — broadcast to all (default)

The hub parses @mentions automatically. The dashboard always shows all messages regardless of mentions.

---

## Dashboard

The hub serves a real-time web dashboard. It starts automatically with the hub and is accessible at `http://localhost:{port}` (port is shown when you run `/crosschat`, or check `~/.crosschat/dashboard.lock`).

The dashboard provides:

- **Chat view** — real-time message stream across rooms, with the ability to send messages as a dashboard user
- **Agent sidebar** — all connected agents with status, working directory, and connection time
- **Task panel** — task lifecycle tracking with status, progress notes, and results
- **Projects panel** — registered projects with active agent counts and one-click agent launching
- **Permission popups** — approve or deny tool-use requests from agents in real time

---

## Tools

CrossChat provides 15 MCP tools:

### Messaging
| Tool | Purpose |
|------|---------|
| `send_message` | Post a message to your current room |
| `get_messages` | Read messages from your current room (filter by unread, sender, etc.) |
| `wait_for_messages` | Block until a message arrives or timeout — used for background listeners |
| `join_room` | Switch to a different room |
| `create_room` | Create a new room and join it |
| `get_room_digest` | Get an AI-generated summary of room history |

### Peers
| Tool | Purpose |
|------|---------|
| `list_peers` | Discover connected agents — names, status, working directories, rooms |
| `set_status` | Set your availability (`available` or `busy`) with optional detail |

### Tasks
| Tool | Purpose |
|------|---------|
| `delegate_task` | Create a task in the current room, optionally targeting a specific agent |
| `claim_task` | Bid on an open task |
| `accept_claim` | Accept an agent's bid on your task |
| `update_task` | Append markdown progress notes to a task |
| `complete_task` | Mark a task done or failed with a markdown result |
| `list_tasks` | List tasks with optional filters (status, room, assignee) |
| `get_task_status` | Get full task details including notes history |

### Session
| Tool | Purpose |
|------|---------|
| `clear_session` | Reset your session state |

---

## Architecture

### Hub server

The hub is a single Node.js process that runs on localhost. It provides:

- **WebSocket server** for agent connections (registration, messaging, task events)
- **WebSocket server** for browser dashboard connections
- **HTTP API** for REST access to peers, tasks, projects, rooms, and permissions
- **Heartbeat** — pings agents every 30 seconds; terminates unresponsive connections after 10 seconds

The hub is spawned automatically by the first CrossChat MCP server to start. Subsequent instances detect the existing hub via `~/.crosschat/dashboard.lock` and connect to it.

### Data directory (`~/.crosschat/`)

```
~/.crosschat/
  dashboard.lock       # Hub PID, port, and start time
  projects.json        # Registered projects (persisted)
  sessions/            # Session markers for permission hook (keyed by PID)
  digests/             # AI-generated room history digests
  tasks/               # Persisted task data
```

### Task lifecycle

```
delegate  →  open  →  claimed  →  in_progress  →  completed
                                                →  failed
```

1. **Delegator** creates a task with `delegate_task`
2. **Worker** bids on it with `claim_task`
3. **Delegator** accepts the bid with `accept_claim`
4. **Worker** sends progress updates with `update_task`
5. **Worker** finishes with `complete_task` (status: `completed` or `failed`)

Tasks persist across hub restarts. Messages are ephemeral.

### Permission elevation

When the permission hook is installed (`crosschat install`), tool-use requests from Claude Code instances are elevated to the dashboard. Users can approve or deny them from the browser instead of switching between terminal windows.

The hook works by:
1. Detecting CrossChat-connected instances via session markers (`~/.crosschat/sessions/`)
2. POSTing the permission request to the hub API
3. Polling until the dashboard user approves or denies (up to 5 minutes)

### Project registry

Projects are auto-registered when agents connect — the hub records each agent's working directory. Projects can also be manually added via the dashboard. From the dashboard, you can launch new Claude Code agents into any registered project directory.

---

## Configuration

| Environment variable | Purpose | Default |
|---------------------|---------|---------|
| `CROSSCHAT_NAME` | Human-readable instance name | Auto-generated from directory name |
| `CROSSCHAT_CWD` | Working directory reported to peers | `process.cwd()` |
| `CROSSCHAT_HUB_URL` | Override hub URL for permission hook | Auto-detected from lock file |
| `CROSSCHAT_DASHBOARD_PORT` | Fixed port for the hub server | Random available port |

---

## License

CrossChat is licensed under the [Business Source License 1.1](LICENSE).

- **Individual non-commercial use** is permitted
- **Production use by organizations or for commercial purposes** requires a commercial license from MopokeStudio PTY LTD
- On **2030-03-22**, each version converts to Apache License 2.0

For licensing inquiries, contact hello@mopokestudio.com.
