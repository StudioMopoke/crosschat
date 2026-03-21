import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { generateId } from './util/id.js';
import { log, logError } from './util/logger.js';
import { isProcessAlive } from './util/pid.js';
import { MessageStore } from './stores/message-store.js';
import { AgentConnection } from './hub/agent-connection.js';
import { createMcpServer } from './server.js';
import type { PeerMessage } from './types.js';
import type { RoomMessageMessage } from './hub/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CROSSCHAT_DIR = path.join(os.homedir(), '.crosschat');
const DASHBOARD_LOCK_FILE = path.join(CROSSCHAT_DIR, 'dashboard.lock');
const SESSIONS_DIR = path.join(CROSSCHAT_DIR, 'sessions');
const HUB_MAIN_PATH = path.join(__dirname, '..', 'dist', 'hub', 'hub-main.js');
// When running from dist directly, hub-main.js is a sibling directory
const HUB_MAIN_PATH_ALT = path.join(__dirname, 'hub', 'hub-main.js');

const LOCK_POLL_INTERVAL_MS = 500;
const LOCK_POLL_TIMEOUT_MS = 5_000;

interface DashboardLock {
  pid: number;
  port: number;
  startedAt: string;
}

/**
 * Read and validate the dashboard lock file.
 * Returns the lock data if the file exists and the process is alive,
 * otherwise cleans up the stale lock and returns null.
 */
async function readDashboardLock(): Promise<DashboardLock | null> {
  try {
    const data = await fs.readFile(DASHBOARD_LOCK_FILE, 'utf-8');
    const lock = JSON.parse(data) as DashboardLock;
    if (isProcessAlive(lock.pid)) {
      return lock;
    }
    // Stale lock — remove it
    await fs.unlink(DASHBOARD_LOCK_FILE).catch(() => {});
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the path to hub-main.js, checking both possible locations
 * (project root dist/ and co-located dist/).
 */
async function resolveHubMainPath(): Promise<string> {
  // Try the co-located path first (when running from dist/)
  try {
    await fs.access(HUB_MAIN_PATH_ALT);
    return HUB_MAIN_PATH_ALT;
  } catch {
    // Fall through
  }
  // Try the project-root path (when running from src/ during dev)
  try {
    await fs.access(HUB_MAIN_PATH);
    return HUB_MAIN_PATH;
  } catch {
    // Fall through
  }
  // Default to the co-located path and let spawn fail with a clear error
  return HUB_MAIN_PATH_ALT;
}

/**
 * Spawn the hub server as a detached child process.
 * The hub writes its own lock file once ready.
 */
async function spawnHub(): Promise<void> {
  const hubPath = await resolveHubMainPath();
  log(`Spawning hub: node ${hubPath}`);

  const child = spawn(process.execPath, [hubPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
}

/**
 * Wait for the hub lock file to appear with a valid port.
 * Polls every LOCK_POLL_INTERVAL_MS up to LOCK_POLL_TIMEOUT_MS.
 */
async function waitForHubLock(): Promise<DashboardLock> {
  const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const lock = await readDashboardLock();
    if (lock) {
      return lock;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Hub did not write lock file within ${LOCK_POLL_TIMEOUT_MS}ms. ` +
    `Check ~/.crosschat/ for errors.`
  );
}

/**
 * Ensure the hub is running and return its port.
 * If no live hub is detected, spawns one and waits for it to be ready.
 */
async function ensureHub(): Promise<DashboardLock> {
  // Check for an existing running hub
  const existingLock = await readDashboardLock();
  if (existingLock) {
    log(`Hub already running on port ${existingLock.port} (pid ${existingLock.pid})`);
    return existingLock;
  }

  // No hub running — spawn one
  await spawnHub();
  const lock = await waitForHubLock();
  log(`Hub started on port ${lock.port} (pid ${lock.pid})`);
  return lock;
}

export async function startServer(): Promise<void> {
  const peerId = generateId();
  const cwd = process.env.CROSSCHAT_CWD || process.cwd();
  const dirName = cwd.split('/').filter(Boolean).pop() || 'unknown';
  const peerName = process.env.CROSSCHAT_NAME || `${dirName}-${peerId.slice(0, 4)}`;

  log(`Starting CrossChat agent: ${peerName} (${peerId})`);

  // 1. Ensure the hub is running and get its port
  let dashboardInfo: { port: number } | { error: string };
  let hubPort: number;
  try {
    const hubLock = await ensureHub();
    hubPort = hubLock.port;
    dashboardInfo = { port: hubPort };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logError('Failed to start/find hub', err);
    throw new Error(`Cannot start CrossChat: hub unavailable — ${errorMsg}`);
  }

  // 2. Create the agent connection to the hub
  const agentConnection = new AgentConnection(hubPort, peerId, peerName, cwd);

  // 3. Create the local message store (bridges hub messages for MCP tool access)
  const messageStore = new MessageStore();

  // 4. Bridge hub room messages into the local MessageStore
  agentConnection.onMessage((msg: RoomMessageMessage) => {
    // Skip messages from ourselves to avoid echo
    if (msg.fromPeerId === peerId) return;

    const peerMessage: PeerMessage = {
      messageId: msg.messageId,
      fromPeerId: msg.fromPeerId,
      fromName: msg.fromName,
      content: msg.content,
      metadata: msg.metadata,
      sentAt: msg.timestamp,
      receivedAt: new Date().toISOString(),
      read: false,
      type: 'message',
      mentions: msg.mentions,
      mentionType: msg.mentionType,
      importance: msg.importance,
    };
    messageStore.add(peerMessage);
  });

  // 5. Bridge task events into the MessageStore as informational messages
  agentConnection.onTaskEvent((evt) => {
    let content: string;
    let type: PeerMessage['type'] = 'message';

    switch (evt.type) {
      case 'task.created':
        content = `[TASK CREATED] ${evt.task.description} (taskId: ${evt.task.taskId})`;
        type = 'task_delegated';
        break;
      case 'task.claimed':
        content = `[TASK CLAIMED] Task ${evt.taskId} claimed by ${evt.claimantName} (${evt.claimantId})`;
        break;
      case 'task.claimAccepted':
        content = `[TASK ACCEPTED] You have been assigned task ${evt.taskId}`;
        break;
      case 'task.updated':
        content = `[TASK UPDATED] Task ${evt.taskId}: ${evt.note.content.slice(0, 200)}`;
        break;
      case 'task.completed':
        content = `[TASK ${evt.status === 'completed' ? 'COMPLETED' : 'FAILED'}] Task ${evt.taskId}${evt.result ? `: ${evt.result.slice(0, 200)}` : ''}`;
        type = 'task_result';
        break;
      default:
        return;
    }

    const taskMessage: PeerMessage = {
      messageId: generateId(),
      fromPeerId: 'hub',
      fromName: 'CrossChat Hub',
      content,
      sentAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      read: false,
      type,
    };
    messageStore.add(taskMessage);
  });

  // 6. Connect to the hub
  agentConnection.connect();

  // 6b. Write session marker so the permission hook can detect this instance.
  //     Key by parent PID (Claude Code's PID) — the hook uses $PPID which matches.
  const sessionFile = path.join(SESSIONS_DIR, `${process.ppid}`);
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    await fs.writeFile(sessionFile, JSON.stringify({
      name: peerName,
      peerId,
      connectedAt: new Date().toISOString(),
    }));
  } catch (err) {
    logError('Failed to write session marker', err);
  }

  // 7. Create and connect the MCP server
  const mcpServer = createMcpServer(peerId, peerName, messageStore, agentConnection, dashboardInfo);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  // 8. Shutdown handler
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down...');

    agentConnection.disconnect();
    await mcpServer.close();

    // Clean up session marker
    await fs.unlink(sessionFile).catch(() => {});

    log('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  process.stdin.on('end', shutdown);

  log(`CrossChat agent ready: ${peerName} (${peerId})`);
}
