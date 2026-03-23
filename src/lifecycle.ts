import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { generateId } from './util/id.js';
import { log, logError } from './util/logger.js';
import { isProcessAlive } from './util/pid.js';
import { MessageStore } from './stores/message-store.js';
import { AgentConnection } from './hub/agent-connection.js';
import { createMcpServer } from './server.js';
import type { PeerMessage } from './types.js';
import type { ChannelMessageMessage, MessageBadgeAddedMessage } from './hub/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const CROSSCHAT_DIR = path.join(os.homedir(), '.crosschat');
const DASHBOARD_LOCK_FILE = path.join(CROSSCHAT_DIR, 'dashboard.lock');
const HUB_MAIN_PATH = path.join(__dirname, '..', 'dist', 'hub', 'hub-main.js');
// When running from dist directly, hub-main.js is a sibling directory
const HUB_MAIN_PATH_ALT = path.join(__dirname, 'hub', 'hub-main.js');

const LOCK_POLL_INTERVAL_MS = 500;
const LOCK_POLL_TIMEOUT_MS = 5_000;

interface DashboardLock {
  pid: number;
  port: number;
  version?: string;
  startedAt: string;
}

async function readDashboardLock(): Promise<DashboardLock | null> {
  try {
    const data = await fs.readFile(DASHBOARD_LOCK_FILE, 'utf-8');
    const lock = JSON.parse(data) as DashboardLock;
    if (isProcessAlive(lock.pid)) {
      return lock;
    }
    await fs.unlink(DASHBOARD_LOCK_FILE).catch(() => {});
    return null;
  } catch {
    return null;
  }
}

async function resolveHubMainPath(): Promise<string> {
  try {
    await fs.access(HUB_MAIN_PATH_ALT);
    return HUB_MAIN_PATH_ALT;
  } catch { /* fall through */ }
  try {
    await fs.access(HUB_MAIN_PATH);
    return HUB_MAIN_PATH;
  } catch { /* fall through */ }
  return HUB_MAIN_PATH_ALT;
}

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

async function ensureHub(): Promise<DashboardLock> {
  const existingLock = await readDashboardLock();
  if (existingLock) {
    if (existingLock.version && existingLock.version !== pkg.version) {
      log(
        `Hub version mismatch: running v${existingLock.version}, we are v${pkg.version}. ` +
        `Stopping old hub (pid ${existingLock.pid}) and spawning new one.`
      );
      try {
        process.kill(existingLock.pid, 'SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      } catch { /* Process already gone */ }
      await fs.unlink(DASHBOARD_LOCK_FILE).catch(() => {});
    } else {
      log(`Hub already running on port ${existingLock.port} (pid ${existingLock.pid})`);
      return existingLock;
    }
  }

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

  // 4. Bridge hub channel messages into the local MessageStore
  agentConnection.onMessage((msg: ChannelMessageMessage) => {
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
      threadId: msg.threadId,
      mentions: msg.mentions,
      mentionType: msg.mentionType,
      importance: msg.importance,
      badges: msg.badges,
    };
    messageStore.add(peerMessage);
  });

  // 5. Bridge badge events into the MessageStore
  agentConnection.onBadge((evt: MessageBadgeAddedMessage) => {
    const badgeMessage: PeerMessage = {
      messageId: generateId(),
      fromPeerId: 'system',
      fromName: 'CrossChat',
      content: `[BADGE] ${evt.badge.type}:${evt.badge.value} on message ${evt.messageId}`,
      sentAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      read: false,
      type: 'badge_update',
      metadata: { targetMessageId: evt.messageId, badge: evt.badge },
    };
    messageStore.add(badgeMessage);
  });

  // 6. Connect to the hub
  agentConnection.connect();

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

    log('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  process.stdin.on('end', shutdown);

  // 9. Monitor parent process (Claude Code) — disconnect if it dies
  const parentPid = process.ppid;
  const parentCheckInterval = setInterval(() => {
    if (!isProcessAlive(parentPid)) {
      log(`Parent process (pid ${parentPid}) is no longer alive — shutting down`);
      clearInterval(parentCheckInterval);
      shutdown();
    }
  }, 5_000);
  parentCheckInterval.unref();

  log(`CrossChat agent ready: ${peerName} (${peerId})`);
}
