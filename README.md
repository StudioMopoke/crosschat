# CrossChat

CrossChat is an MCP server that lets Claude Code instances talk to each other. It runs as a child process of each Claude Code session, enabling peer discovery, messaging, and task delegation — all on a single machine.

## How it works

Each Claude Code instance spawns its own CrossChat server. The server does two things:

1. **Talks to Claude Code** over stdio using the MCP protocol — this is how Claude gets the tools for discovery, messaging, and delegation.
2. **Talks to other CrossChat servers** over Unix domain sockets using JSON-RPC — this is how messages actually travel between instances.

```
┌─────────────┐       stdio (MCP)       ┌──────────────┐
│ Claude Code  │ ◄────────────────────► │  CrossChat A  │
│ Instance A   │                         │  UDS: a.sock  │
└─────────────┘                         └──────┬───────┘
                                               │
                                          peer-to-peer
                                          (Unix socket)
                                               │
┌─────────────┐       stdio (MCP)       ┌──────┴───────┐
│ Claude Code  │ ◄────────────────────► │  CrossChat B  │
│ Instance B   │                         │  UDS: b.sock  │
└─────────────┘                         └──────────────┘
```

**Discovery** works through a shared file registry at `~/.crosschat/`. Each server writes a JSON file with its peer ID, name, PID, socket path, and status. When Claude asks "who else is running?", the server reads all the registry files and returns the live ones.

**Stale cleanup** happens automatically. On startup and every 30 seconds, the server checks if registered peers are still alive (via PID checks) and removes dead entries.

---

## Setup

### Prerequisites

- Node.js 20+
- Claude Code with MCP support

### Install

```bash
git clone <repo-url> crosschat
cd crosschat
npm install
npm run build
```

### Configure Claude Code

Add CrossChat to your MCP configuration. You can do this globally (`~/.claude/settings.json`) or per-project (`.claude/settings.json`).

For two instances that will collaborate, each needs a unique name:

**Instance A** — the orchestrator:
```json
{
  "mcpServers": {
    "crosschat": {
      "command": "node",
      "args": ["/path/to/crosschat/dist/index.js"],
      "env": {
        "CROSSCHAT_NAME": "orchestrator"
      }
    }
  }
}
```

**Instance B** — a worker peer:
```json
{
  "mcpServers": {
    "crosschat": {
      "command": "node",
      "args": ["/path/to/crosschat/dist/index.js"],
      "env": {
        "CROSSCHAT_NAME": "frontend-worker"
      }
    }
  }
}
```

You can also use `tsx` for development:
```json
{
  "args": ["tsx", "/path/to/crosschat/src/index.ts"]
}
```

The `CROSSCHAT_NAME` environment variable sets the human-readable name other instances will see. If omitted, a name is auto-generated from the peer ID.

---

## Using CrossChat

### Starting a session

Once configured, CrossChat starts automatically with Claude Code. To begin collaborating, tell Claude:

> "Start CrossChat as an orchestrator"

or

> "Start CrossChat as a peer"

Claude will invoke the `crosschat` prompt, which sets up the appropriate role:

- **Orchestrator** — discovers peers, delegates tasks, coordinates results, and reports back to you. Thinks of itself as the lead that breaks problems into pieces.
- **Peer** — announces itself to existing instances, sets up a background listener for incoming messages, and waits for work. When it receives a task, it asks you before proceeding.

You can also let Claude ask you which role you want:

> "Start CrossChat"

### The orchestrator/peer workflow

A typical collaboration session looks like this:

**1. Start instances.** Open two (or more) Claude Code sessions. Start one as an orchestrator and the others as peers.

**2. Peers announce themselves.** When a peer starts, it broadcasts a `[PEER AVAILABLE]` message to all existing instances with its name and working directory. The orchestrator's listener picks this up and tells you.

**3. Orchestrator assigns work.** Tell the orchestrator what needs to be done. It breaks the work down, checks which peers are available, and delegates tasks.

**4. Peers work.** When a peer receives a task, it sets its status to "busy" (so other orchestrators don't double-book it), asks you for confirmation, then does the work.

**5. Peers report back.** When a peer finishes, it sends the result to the orchestrator and sets its status back to "available". The orchestrator is automatically notified.

**6. Orchestrator synthesizes.** The orchestrator collects results from all peers and presents a summary.

### Example conversation

**Terminal 1 — Orchestrator:**
```
You: Start CrossChat as orchestrator

Claude: I've discovered 2 peers:
  - frontend-worker (working in /app/frontend) — available
  - api-worker (working in /app/api) — available
  Listener is active. What would you like me to coordinate?

You: Run the test suites in both projects

Claude: Delegating tasks:
  - frontend-worker: "Run the test suite and report results"
  - api-worker: "Run the test suite and report results"
  Both tasks sent. I'll let you know when they respond.

Claude: frontend-worker has finished: 42 tests passed, 0 failed.
Claude: api-worker has finished: 18 tests passed, 2 failed.
  Failures:
  - test_auth_middleware: expected 401, got 500
  - test_rate_limiter: timeout after 5s
```

**Terminal 2 — Frontend worker:**
```
You: Start CrossChat as peer

Claude: Announced myself to 1 peer (orchestrator). Listening for messages.

Claude: Incoming task from orchestrator: "Run the test suite and report results"
  Should I proceed?

You: Yes

Claude: Running tests... All 42 tests passed. Sent results back to orchestrator.
  Status set to available.
```

### Messaging without roles

You don't have to use the orchestrator/peer pattern. CrossChat also works for simple messaging between instances:

> "Send a message to frontend-worker: what branch are you on?"

> "Check my CrossChat messages"

> "Who else is running?"

### Status management

Peers can be in one of two states:

- **available** — ready for new work
- **busy** — currently working on something

When a peer starts working on a delegated task, it sets itself to "busy" with a description of what it's doing. Orchestrators see this in `list_peers` and skip busy peers when delegating new work.

When a peer finishes and sets itself back to "available", the orchestrator that assigned the work is automatically notified with a `[PEER AVAILABLE]` message.

### Background listener

CrossChat uses a background agent pattern for receiving messages. Instead of polling, Claude spawns a lightweight sub-agent (Haiku) that calls `wait_for_messages` — a tool that blocks until a message arrives or times out. This means:

- No busy-polling, no wasted tokens
- Messages are surfaced as soon as they arrive
- Claude can continue doing other work while listening

The listener is set up automatically when you start in orchestrator or peer mode. You can also set it up manually:

> "Start listening for CrossChat messages"

---

## Tools

CrossChat provides 7 MCP tools:

| Tool | Purpose |
|------|---------|
| `list_peers` | Discover other instances — IDs, names, status, working directories |
| `send_message` | Send a message to a peer by ID |
| `get_messages` | Read your inbox — filter by sender, unread only, with pagination |
| `delegate_task` | Assign a task to a peer — returns a task ID for tracking |
| `get_task_status` | Poll a delegated task's status (pending/in_progress/completed/failed/timed_out) |
| `wait_for_messages` | Long-poll for incoming messages — blocks until one arrives or timeout |
| `set_status` | Set your availability (available/busy) — auto-notifies orchestrator on completion |

## Prompts

MCP prompts provide guided workflows:

| Prompt | Purpose |
|--------|---------|
| `crosschat` | Main entry point — choose orchestrator or peer role |
| `check-inbox` | Check for new messages and tasks |
| `discover-peers` | Find all instances and what they're working on |
| `send-to-peer` | Guided message composition |
| `delegate-work` | Guided task delegation |
| `start-listening` | Set up background message listener |
| `my-identity` | Show your peer ID, name, and connection info |

---

## Architecture

### Registry (`~/.crosschat/`)

```
~/.crosschat/
  peers/
    {peerId}.json      # Peer metadata, status, socket path
  sockets/
    {peerId}.sock      # Unix domain socket for peer-to-peer comms
```

Each peer's registry entry:
```json
{
  "peerId": "550e8400-e29b-41d4-a716-446655440000",
  "name": "frontend-worker",
  "pid": 12345,
  "socketPath": "/Users/you/.crosschat/sockets/550e8400-....sock",
  "registeredAt": "2026-03-18T10:30:00.000Z",
  "status": "available",
  "statusDetail": null,
  "busyWithTaskId": null,
  "orchestratorPeerId": null,
  "metadata": {
    "cwd": "/Users/you/projects/frontend",
    "parentPid": 12340
  }
}
```

Writes are atomic (write to `.tmp`, then `rename`). Reads tolerate missing or malformed files.

### Peer-to-peer protocol

Peers communicate over Unix domain sockets using newline-delimited JSON-RPC 2.0. Connections are short-lived: open, send request, receive response, close.

Internal methods (not MCP tools — these are the wire protocol between servers):

| Method | Purpose |
|--------|---------|
| `peer.message` | Deliver a message to a peer's inbox |
| `peer.delegate_task` | Request a peer to perform a task |
| `peer.task_update` | Report task progress/completion |
| `peer.ping` | Liveness check (includes status) |
| `peer.status` | Query a peer's current status |

### Storage

Messages and tasks are **in-memory only** — they exist for the lifetime of the server process. This keeps the system simple and avoids stale state across restarts. The interfaces are designed so a persistent store (SQLite, etc.) can be swapped in later if needed.

### Lifecycle

**Startup:**
1. Generate peer ID (`crypto.randomUUID()`)
2. Ensure `~/.crosschat/peers/` and `~/.crosschat/sockets/` exist
3. Prune stale registry entries
4. Start UDS server
5. Write registry entry
6. Connect MCP server to stdio
7. Start periodic cleanup (30s) and task timeout sweep (10s)

**Shutdown** (SIGINT, SIGTERM, or stdin close):
1. Clear intervals
2. Close UDS server
3. Remove registry file and socket file
4. Close MCP transport

---

## Configuration

| Environment variable | Purpose | Default |
|---------------------|---------|---------|
| `CROSSCHAT_NAME` | Human-readable instance name | `peer-{first 8 chars of ID}` |
| `CROSSCHAT_CWD` | Working directory reported to peers | `process.cwd()` |

---

## Limitations

- **Single machine only.** All communication is via Unix domain sockets and a shared filesystem. No networking.
- **No persistence.** Messages and tasks are lost when the server stops.
- **No push notifications.** Claude won't react to incoming messages unless it's actively listening via the background agent pattern or manually checks its inbox.
- **No authentication.** Any process on the machine can read the registry and connect to a peer's socket. This is designed for local development, not multi-tenant environments.
