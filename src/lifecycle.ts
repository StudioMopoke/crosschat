import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateId } from './util/id.js';
import { log, logError } from './util/logger.js';
import { ensureDirectories, writeRegistryEntry, removeRegistryEntry, removeSocketFile, getSocketPath } from './registry/registry.js';
import { pruneStaleEntries } from './registry/cleanup.js';
import { UdsServer, type RequestHandler } from './transport/uds-server.js';
import { MessageStore } from './stores/message-store.js';
import { TaskStore } from './stores/task-store.js';
import { createMcpServer } from './server.js';
import { DashboardServer } from './dashboard/http-server.js';
import { MessageBridge } from './dashboard/message-bridge.js';
import { isProcessAlive } from './util/pid.js';
import type { PeerRegistryEntry, PeerStatus, PeerMessage, InboundTask, PeerMessageParams, PeerDelegateTaskParams, PeerTaskUpdateParams } from './types.js';

const PRUNE_INTERVAL_MS = 30_000;
const TASK_SWEEP_INTERVAL_MS = 10_000;
const DASHBOARD_LOCK_FILE = path.join(os.homedir(), '.crosschat', 'dashboard.lock');

interface DashboardLock {
  pid: number;
  port: number;
  startedAt: string;
}

async function readDashboardLock(): Promise<DashboardLock | null> {
  try {
    const data = await fs.readFile(DASHBOARD_LOCK_FILE, 'utf-8');
    const lock = JSON.parse(data) as DashboardLock;
    // Check if the process is still alive
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

async function writeDashboardLock(port: number): Promise<void> {
  const lock: DashboardLock = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  };
  const tmpPath = `${DASHBOARD_LOCK_FILE}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(lock, null, 2), 'utf-8');
  await fs.rename(tmpPath, DASHBOARD_LOCK_FILE);
}

async function removeDashboardLock(): Promise<void> {
  try {
    const lock = await readDashboardLock();
    if (lock && lock.pid === process.pid) {
      await fs.unlink(DASHBOARD_LOCK_FILE);
    }
  } catch {}
}

export async function startServer(): Promise<void> {
  const peerId = generateId();
  const cwd = process.env.CROSSCHAT_CWD || process.cwd();
  const dirName = cwd.split('/').filter(Boolean).pop() || 'unknown';
  const peerName = process.env.CROSSCHAT_NAME || `${dirName}-${peerId.slice(0, 4)}`;

  log(`Starting CrossChat server: ${peerName} (${peerId})`);

  // 1. Ensure directories
  await ensureDirectories();

  // 2. Prune stale entries
  await pruneStaleEntries();

  // 3. Create stores
  const messageStore = new MessageStore();
  const taskStore = new TaskStore();

  // 4. Build peer request handler
  const handlePeerRequest: RequestHandler = async (method, params) => {
    switch (method) {
      case 'peer.ping':
        return { peerId, name: peerName, alive: true, status: entry.status, statusDetail: entry.statusDetail };

      case 'peer.status':
        return { peerId, name: peerName, status: entry.status, statusDetail: entry.statusDetail, busyWithTaskId: entry.busyWithTaskId, orchestratorPeerId: entry.orchestratorPeerId };

      case 'peer.message': {
        const p = params as unknown as PeerMessageParams;
        const message: PeerMessage = {
          messageId: p.messageId,
          fromPeerId: p.fromPeerId,
          fromName: p.fromName,
          content: p.content,
          metadata: p.metadata,
          sentAt: p.sentAt,
          receivedAt: new Date().toISOString(),
          read: false,
          relatedTaskId: p.relatedTaskId,
          replyToMessageId: p.replyToMessageId,
          type: 'message',
        };
        messageStore.add(message);
        log(`Received message from ${p.fromName} (${p.fromPeerId})`);
        return { received: true, messageId: p.messageId };
      }

      case 'peer.delegate_task': {
        const p = params as unknown as PeerDelegateTaskParams;
        const inbound: InboundTask = {
          taskId: p.taskId,
          fromPeerId: p.fromPeerId,
          fromName: p.fromName,
          description: p.description,
          context: p.context,
          status: 'pending',
          receivedAt: new Date().toISOString(),
        };
        taskStore.addInbound(inbound);

        // Surface the task as a message in the inbox
        const taskMessage: PeerMessage = {
          messageId: generateId(),
          fromPeerId: p.fromPeerId,
          fromName: p.fromName,
          content: `[TASK DELEGATED] ${p.description}${p.context ? `\n\nContext: ${p.context}` : ''}`,
          sentAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
          read: false,
          relatedTaskId: p.taskId,
          type: 'task_delegated',
        };
        messageStore.add(taskMessage);
        log(`Received delegated task from ${p.fromName}: ${p.description.slice(0, 80)}`);
        return { accepted: true, taskId: p.taskId };
      }

      case 'peer.task_update': {
        const p = params as unknown as PeerTaskUpdateParams;
        const task = taskStore.getDelegated(p.taskId);
        if (!task) {
          throw new Error(`Unknown task: ${p.taskId}`);
        }
        taskStore.updateDelegatedStatus(p.taskId, p.status, p.result, p.error);
        log(`Task ${p.taskId} updated to ${p.status}`);

        // Surface task completion/failure as a message so the delegator sees it
        if (p.status === 'completed' || p.status === 'failed') {
          const statusLabel = p.status === 'completed' ? 'TASK COMPLETED' : 'TASK FAILED';
          const body = p.status === 'completed' ? (p.result || 'No result provided') : (p.error || 'No error details');
          const resultMessage: PeerMessage = {
            messageId: generateId(),
            fromPeerId: task.targetPeerId,
            fromName: task.targetName,
            content: `[${statusLabel}] Task: ${task.description}\n\n${body}`,
            sentAt: new Date().toISOString(),
            receivedAt: new Date().toISOString(),
            read: false,
            relatedTaskId: p.taskId,
            type: 'task_result',
          };
          messageStore.add(resultMessage);
        }

        return { updated: true };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  };

  // 5. Start UDS server
  const socketPath = getSocketPath(peerId);
  const udsServer = new UdsServer(socketPath, handlePeerRequest);
  await udsServer.start();

  // 6. Write registry entry
  const entry: PeerRegistryEntry = {
    peerId,
    name: peerName,
    pid: process.pid,
    socketPath,
    registeredAt: new Date().toISOString(),
    status: 'available',
    metadata: {
      cwd: process.env.CROSSCHAT_CWD || process.cwd(),
      parentPid: process.ppid,
    },
  };
  await writeRegistryEntry(entry);

  // 7. Start dashboard if no other instance is running it
  let dashboard: DashboardServer | null = null;
  let bridge: MessageBridge | null = null;
  const existingLock = await readDashboardLock();
  if (!existingLock) {
    try {
      const dashboardPort = process.env.CROSSCHAT_DASHBOARD_PORT ? parseInt(process.env.CROSSCHAT_DASHBOARD_PORT, 10) : 0;
      dashboard = new DashboardServer(dashboardPort);
      const actualPort = await dashboard.start();
      await writeDashboardLock(actualPort);

      bridge = new MessageBridge(messageStore, dashboard, peerName, peerId);
      bridge.start();

      // Post a startup message to the dashboard
      dashboard.postToRoom('crosschat', 'system', `${peerName} started the dashboard on port ${actualPort}`);
    } catch (err) {
      logError('Failed to start dashboard', err);
      dashboard = null;
    }
  } else {
    log(`Dashboard already running on port ${existingLock.port} (pid ${existingLock.pid})`);
  }

  // 8. Create and connect MCP server
  const mcpServer = createMcpServer(peerId, peerName, messageStore, taskStore, entry, dashboard);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  // 9. Start periodic intervals
  const pruneInterval = setInterval(async () => {
    try {
      await pruneStaleEntries(peerId);
    } catch (err) {
      logError('Prune interval error', err);
    }
  }, PRUNE_INTERVAL_MS);
  pruneInterval.unref();

  const taskSweepInterval = setInterval(() => {
    taskStore.sweepTimedOutTasks();
  }, TASK_SWEEP_INTERVAL_MS);
  taskSweepInterval.unref();

  // 10. Shutdown handler
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down...');

    clearInterval(pruneInterval);
    clearInterval(taskSweepInterval);

    if (bridge) bridge.stop();
    if (dashboard) {
      await dashboard.close();
      await removeDashboardLock();
    }

    await udsServer.close();
    await removeRegistryEntry(peerId);
    await removeSocketFile(peerId);

    await mcpServer.close();
    log('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);

  log(`CrossChat server ready: ${peerName} (${peerId})`);
}
