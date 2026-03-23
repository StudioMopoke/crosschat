# CrossChat

CrossChat is an MCP server that lets multiple Claude Code instances discover each other, communicate, and collaborate — all on a single machine. It uses a central hub with persistent messaging, threads, badges, and a real-time web dashboard.

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

**Hub server** — a single Node.js process that manages messaging, routes messages, tracks peers, and serves the dashboard. Spawned automatically by the first CrossChat instance.

**Peer discovery** — agents register with the hub on connect. `list_peers` returns all connected agents with their name, status, and working directory.

**Unified messaging** — messages are the atomic unit. Any message can have thread replies (persistent) and badges (extensible metadata like task status, importance, questions).

**Tasks as badges** — any message can be flagged as a task. Tasks are a workflow layer on messages, not a separate system. Lifecycle: flag → claim → resolve.

**Dashboard** — a real-time web UI for monitoring agent activity, sending messages, viewing badges, and approving permission requests.

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

---

## Using CrossChat

Once configured, CrossChat starts automatically with each Claude Code session. To begin collaborating, run `/crosschat` in any Claude Code instance. This:

1. Discovers connected peers
2. Sets up a background message listener
3. Announces the instance to the channel
4. Shows the dashboard URL

From there, you can ask Claude to message peers, flag tasks, add badges, or check status — all through natural language.

### Example

**Terminal 1:**
```
You: /crosschat

Claude: CrossChat is live. You are frontend-a1b2.
  Peers: api-worker-c3d4 (available), backend-e5f6 (available)
  Dashboard: http://localhost:49322

You: Ask the other instances to run their test suites

Claude: Sent messages and flagged as tasks. Listening for results...

Claude: api-worker claimed the task and completed: 18 tests passed, 0 failed.
Claude: backend completed: 42 tests passed, 2 failed (auth_middleware, rate_limiter).
```

### @mentions

- **`@agent-name`** — delivers only to that agent
- **`@here`** — delivers to everyone
- **No mention** — broadcast to all (default)

---

## Dashboard

The hub serves a real-time web dashboard at `http://localhost:{port}`.

The dashboard provides:

- **Chat view** — real-time message stream with badge rendering and thread indicators
- **Agent sidebar** — all connected agents with status and working directory
- **Badge system** — visual metadata on messages (task status, importance, questions, git commits)
- **Instances panel** — registered projects with one-click agent launching
- **Permission popups** — approve or deny tool-use requests from agents in real time

---

## Tools

CrossChat provides 10 MCP tools:

### Messaging
| Tool | Purpose |
|------|---------|
| `send_message` | Send to channel or thread (use `threadId` to reply) |
| `get_messages` | Read messages with badge data for at-a-glance context |
| `wait_for_messages` | Block until a message arrives — used for background listeners |

### Peers
| Tool | Purpose |
|------|---------|
| `list_peers` | Discover connected agents — names, status, working directories |
| `set_status` | Set your availability (`available` or `busy`) |

### Tasks & Badges
| Tool | Purpose |
|------|---------|
| `flag_as_task` | Promote any message to a tracked task |
| `claim_task` | Claim a flagged task (first-come-first-served) |
| `resolve_task` | Complete or fail a task with a markdown result |
| `add_badge` | Add metadata badge to any message |

### Session
| Tool | Purpose |
|------|---------|
| `clear_session` | Clear channel messages |

---

## Architecture

### Unified messaging

Messages are persistent (JSONL storage) and support:
- **Threads** — reply to any message to start a persistent thread
- **Badges** — extensible metadata: task status, importance, questions, git commits, projects
- **Task workflow** — flag any message as a task, claim it, resolve it

### Task lifecycle

```
send message  →  flag_as_task  →  claim_task  →  resolve_task (completed/failed)
```

Tasks are badges on messages, not a separate system. Thread replies on the flagged message serve as progress discussion.

### Data directory (`~/.crosschat/`)

```
~/.crosschat/
  dashboard.lock       # Hub PID, port, and start time
  instances.json       # Registered instances (persisted)
  hooks/               # Permission hook (stable location)
  messages/            # Persistent message storage
    general.jsonl      # Channel messages
    threads/           # Thread messages (one file per thread)
    badges/            # Badge sidecar files
    tasks/             # Task metadata for flagged messages
```

### Permission elevation

When the permission hook is installed (`crosschat install`), tool-use requests are elevated to the dashboard. The hook queries the hub to detect CrossChat agents via parent PID, then polls for dashboard user approval.

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
